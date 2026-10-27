/* Emscripten pre-run integration only; gameplay remains in native OpenITG. */
(function () {
  if (typeof Module === 'undefined') return;

  // Keep latency short without starving the browser's Web Audio queue.
  Module['SDL_numSimultaneouslyQueuedBuffers'] = 3;
  Module['SDL_canPlayWithWebAudio'] = true;

  if (typeof window === 'undefined') return; // pthread worker runtime

  var syncPending = false;
  var syncTimer = null;

  function ensureDirectory(path) {
    try { FS.mkdir(path); } catch (error) {
      // EEXIST is expected on every later run; other errors surface on access.
    }
  }

  function report(message, isError) {
    window.dispatchEvent(new CustomEvent('openitg-storage', {
      detail: { message: message, isError: !!isError }
    }));
  }

  // Serialize import/profile/autosave requests instead of rejecting a user save
  // merely because another IndexedDB reconciliation is already running.
  var syncQueue = Promise.resolve();
  var syncRequests = 0;
  window.OpenITGSync = function (populate) {
    syncRequests++;
    syncPending = true;
    var task = syncQueue.then(function () {
      return new Promise(function (resolve, reject) {
        FS.syncfs(!!populate, function (error) {
          if (error) {
            report('Local save sync failed: ' + error, true);
            reject(error);
          } else {
            report(populate ? 'Local data restored.' : 'Local data saved.', false);
            resolve();
          }
        });
      });
    });
    syncQueue = task.catch(function () {});
    function finished() { syncRequests--; syncPending = syncRequests > 0; }
    task.then(finished, finished);
    return task;
  };

  function canAutosave() {
    return !syncPending && !(window.OpenITGUploads && window.OpenITGUploads.busy);
  }

  Module['preRun'] = Module['preRun'] || [];
  Module['preRun'].push(function () {
    // SDL 1's browser lookup loses keypad Enter's DOM location. Preserve it
    // in the SDK's internal scancode namespace (SDL_SCANCODE_KP_ENTER=88).
    // Leave every other physical key on SDL's normal path.
    if (typeof SDL !== 'undefined' && !SDL.openitgKeyLocationFix) {
      var lookupSDLKey = SDL.lookupKeyCodeForEvent;
      SDL.lookupKeyCodeForEvent = function (event) {
        if (event.code === 'NumpadEnter' || (event.keyCode === 13 && event.location === 3)) return 1024 + 88;
        return lookupSDLKey.call(SDL, event);
      };
      SDL.openitgKeyLocationFix = true;
    }
    ensureDirectory('/persistent');
    FS.mount(IDBFS, {}, '/persistent');
    window.OpenITGFS = FS;

    addRunDependency('openitg-idbfs-load');
    FS.syncfs(true, async function (error) {
      if (error) report('Could not restore IndexedDB data: ' + error, true);

      ['/persistent/Songs', '/persistent/Packages', '/persistent/Data',
       '/persistent/Cache', '/persistent/Logs', '/persistent/Save'].forEach(ensureDirectory);

      // Complete local library maintenance before enabling native main. Do
      // not mutate/remove files from underneath a running Song/Steps pointer.
      if (window.OpenITGUploads) {
        try {
          if (error) window.OpenITGUploads.unavailable('Local storage restoration failed; uploads are disabled for this session.');
          else await window.OpenITGUploads.restore(FS);
        } catch (libraryError) {
          window.OpenITGUploads.unavailable('Local library unavailable: ' + libraryError.message);
          report('Local library unavailable: ' + libraryError.message, true);
        }
      }

      window.dispatchEvent(new CustomEvent('openitg-fs-ready'));
      report(error ? 'Using a temporary in-memory local filesystem.' : 'Persistent local storage ready.', !!error);
      removeRunDependency('openitg-idbfs-load');

      if (!syncTimer) {
        syncTimer = setInterval(function () {
          if (canAutosave()) window.OpenITGSync(false).catch(function () {});
        }, 15000);
      }
    });
  });

  window.addEventListener('pagehide', function () {
    if (window.OpenITGFS && canAutosave()) window.OpenITGSync(false).catch(function () {});
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && window.OpenITGFS && canAutosave()) window.OpenITGSync(false).catch(function () {});
  });
})();

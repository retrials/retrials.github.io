(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const core=window.OpenITGInputCore, canvas=$('canvas'), dialog=$('settings-panel');
  const KEY='openitg-web-controls-v7';
  let preferences={touch:'auto',gamepad:true,threshold:0.5,wake:true,devices:{}};
  try {
    const stored=JSON.parse(localStorage.getItem(KEY)||'null');
    if(stored) {
      if(['auto','on','off'].includes(stored.touch))preferences.touch=stored.touch;
      if(typeof stored.gamepad==='boolean')preferences.gamepad=stored.gamepad;
      if(Number.isFinite(stored.threshold)&&stored.threshold>=0.25&&stored.threshold<=0.85)preferences.threshold=stored.threshold;
      if(typeof stored.wake==='boolean')preferences.wake=stored.wake;
      if(stored.devices&&typeof stored.devices==='object') for(const [id,value] of Object.entries(stored.devices))
        if(id.startsWith('pad:')&&core.validBindings(value))preferences.devices[id]=value;
    }
  } catch(_) { $('web-feature-status').textContent='Preferences could not be restored; using defaults.'; }
  let toastTimer;
  function say(message){$('web-feature-status').textContent=message;$('feature-toast').textContent=message;$('feature-toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>{$('feature-toast').hidden=true;},6500);}
  function save() {try{localStorage.setItem(KEY,JSON.stringify(preferences));}catch(_){$('web-feature-status').textContent='Preferences are temporary: browser local storage is unavailable.';}}
  let reloadPending=false,lastLibraryState=null;
  let ready=false,running=false,foreground=!document.hidden,learning=null,selected='auto',pad=null,currentPads=[],lastSignature='',lastBindingKey='',wakeLock=null,wakePending=false;
  const pointers=new Map();
  const input=core.router((action,down)=>{
    for(const node of document.querySelectorAll('[data-action="'+action+'"]')) {node.classList.toggle('pressed',down);node.setAttribute('aria-pressed',String(down));}
    if(ready) {
      try {
        if(!window.OpenITGModuleInstance._OpenITGWebInput(action,down?1:0))throw Error('Native input is not ready.');
      } catch(error) {ready=false;$('web-feature-status').textContent='Browser input stopped: '+error.message;}
    }
  });
  const controller=core.gamepad(input);
  function active(){return ready&&foreground&&!dialog.open;}
  function release(){if(ready)window.OpenITGModuleInstance._OpenITGWebReleaseKeyboard?.();input.clear();pointers.clear();controller.reset();for(const n of document.querySelectorAll('[data-action]')){n.classList.remove('pressed');n.setAttribute('aria-pressed','false');}}
  function resume(){input.enable(active());controller.reset();}
  function touchLayout(){
    const coarse=matchMedia('(pointer: coarse)').matches||navigator.maxTouchPoints>0;
    const show=preferences.touch==='on'||(preferences.touch==='auto'&&coarse);
    $('touch-controls').hidden=!show;document.body.classList.toggle('touch-layout',show);
  }
  function bindings(p){return p&&(preferences.devices['pad:'+p.id]||(p.mapping==='standard'?core.defaults:Array.from({length:8},()=>[])));}
  function describe(row){return row.length?row.map(b=>b.kind==='button'?'Button '+b.index:'Axis '+b.index+(b.sign>0?' +':' −')).join(' / '):'Not mapped';}
  function renderBindings(){
    const host=$('gamepad-bindings');host.replaceChildren();
    const map=bindings(pad)||Array.from({length:8},()=>[]);
    core.names.forEach((name,action)=>{
      const row=document.createElement('div');row.className='binding-row';
      const label=document.createElement('span'),small=document.createElement('small');label.textContent=name;small.textContent=describe(map[action]);label.appendChild(small);
      const button=document.createElement('button');button.textContent=learning&&learning.action===action?'Listening…':'Map';button.disabled=!pad;
      button.addEventListener('click',()=>{
        release();
        learning={action,index:pad.index,buttons:pad.buttons.map(b=>!!b.pressed||b.value>=0.65),axes:Array.from(pad.axes)};
        $('gamepad-cancel-learn').hidden=false;$('gamepad-status').textContent='Release the control, then press/move the input for '+name+'.';renderBindings();
      });
      row.append(label,button);host.appendChild(row);
    });
  }
  function cancelLearn(){learning=null;$('gamepad-cancel-learn').hidden=true;renderBindings();}
  function learn(p){
    if(!learning||!dialog.open||p.index!==learning.index)return;
    let found=null;
    for(let i=0;i<Math.min(p.buttons.length,64);i++) {
      const down=!!p.buttons[i].pressed||p.buttons[i].value>=0.65;
      if(down&&!learning.buttons[i]){found={kind:'button',index:i};break;}
      learning.buttons[i]=down;
    }
    if(!found) for(let i=0;i<Math.min(p.axes.length,16);i++){
      if(Math.abs(p.axes[i])<0.25)learning.axes[i]=p.axes[i];
      if(Math.abs(p.axes[i])>=0.65&&Math.abs(p.axes[i]-(learning.axes[i]||0))>=0.6){found={kind:'axis',index:i,sign:p.axes[i]>0?1:-1};break;}
    }
    if(found){
      const mapping=core.clone(bindings(p));mapping[learning.action]=[found];
      preferences.devices['pad:'+p.id]=mapping;save();cancelLearn();controller.reset();
      $('gamepad-status').textContent='Mapping saved on this device. Close Settings, release all controls, then play.';
    }
  }
  function poll(){
    let blocked='';
    try{currentPads=navigator.getGamepads?Array.from(navigator.getGamepads()).filter(p=>p&&p.connected):[];}
    catch(error){currentPads=[];blocked='Gamepad access blocked. Open the game directly or allow gamepad access in the host iframe.';}
    pad=selected==='auto'?currentPads[0]||null:currentPads.find(p=>String(p.index)===selected)||null;
    const signature=currentPads.map(p=>p.index+':'+p.id+':'+p.mapping).join('|');
    if(signature!==lastSignature){
      lastSignature=signature;
      const dropdown=$('gamepad-device');dropdown.replaceChildren();
      const auto=document.createElement('option');auto.value='auto';auto.textContent='First connected controller';dropdown.appendChild(auto);
      for(const p of currentPads){const option=document.createElement('option');option.value=String(p.index);option.textContent=p.id;dropdown.appendChild(option);}
      if(selected!=='auto'&&!currentPads.some(p=>String(p.index)===selected)){
        const missing=document.createElement('option');missing.value=selected;missing.textContent='Selected controller disconnected';dropdown.appendChild(missing);
      }
      dropdown.value=selected;
    }
    const bindingKey=pad?pad.index+':'+pad.id: 'none';
    if(bindingKey!==lastBindingKey){lastBindingKey=bindingKey;cancelLearn();$('gamepad-status').textContent=pad?(pad.mapping==='standard'?'Standard controller ready. Release controls before resuming.':'Nonstandard controller: map its controls below.'):'Connect a controller, then press and release a button.';}
    if(blocked||!navigator.getGamepads)$('gamepad-status').textContent=blocked||'This browser has no Gamepad API. Keyboard and touch still work.';
    const badge=pad?'Controller · P1':'Keyboard';if($('controller-badge').textContent!==badge)$('controller-badge').textContent=badge;
    if(learning&&pad)learn(pad);
    controller.poll(pad,bindings(pad),preferences.threshold,active()&&preferences.gamepad);
    requestAnimationFrame(poll);
  }
  // Do not swallow game keys: SDL must see arrows, modifiers, keypad,
  // shortcuts and unmapped keys so native menus and Lua input agree.
  for(const type of ['keydown','keyup']) document.addEventListener(type,event=>{
    if(!dialog.open)return;
    event.stopImmediatePropagation();
    if(event.code==='Escape') {event.preventDefault();if(type==='keydown')closeMenu();}
  },true);
  document.addEventListener('keydown',event=>{
    if(!dialog.open&&event.target===canvas&&['ArrowLeft','ArrowDown','ArrowUp','ArrowRight','Space','Tab','Backspace','F1','F2','F3','F4','F6','F7','F8','F9','F10'].includes(event.code))event.preventDefault();
  },true);
  // Independent quick-controls popup: do not open Settings or pause lanes.
  const special=$('special-controls'), specialButton=$('special-button');
  function closeSpecial(){
    for(const [id,node] of pointers)if(special.contains(node)){
      input.set('touch:'+id,[]);pointers.delete(id);
    }
    for(const action of [4,5,6,7])input.set('special-click:'+action,[]);
    special.hidden=true;specialButton.setAttribute('aria-expanded','false');
  }
  specialButton.addEventListener('click',()=>{
    if(!special.hidden){closeSpecial();return;}
    if(dialog.open)closeMenu();
    special.hidden=false;specialButton.setAttribute('aria-expanded','true');
    if(ready)canvas.focus({preventScroll:true});
  });
  document.addEventListener('pointerdown',event=>{
    if(!special.hidden&&!special.contains(event.target)&&!specialButton.contains(event.target))closeSpecial();
  },true);
  document.addEventListener('keydown',event=>{
    if(event.code==='Escape'&&!special.hidden){
      event.preventDefault();event.stopImmediatePropagation();closeSpecial();
      if(ready)canvas.focus({preventScroll:true});
    }else if(special.contains(event.target))event.stopImmediatePropagation();
  },true);
  document.addEventListener('keyup',event=>{
    if(special.contains(event.target))event.stopImmediatePropagation();
  },true);
  // Pointer input below supports holding Back/Select. Keyboard/assistive
  // activation of these buttons uses a short pulse instead.
  for(const button of special.querySelectorAll('[data-action]'))button.addEventListener('click',event=>{
    if(event.detail!==0||!active())return;
    const action=Number(button.dataset.action),source='special-click:'+action;
    input.set(source,[action]);setTimeout(()=>input.set(source,[]),action===5?1000:100);
  });
  window.addEventListener('blur',closeSpecial);
  window.addEventListener('pagehide',closeSpecial);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)closeSpecial();});
  function endPointer(event){const source='touch:'+event.pointerId;input.set(source,[]);pointers.delete(event.pointerId);}
  for(const button of document.querySelectorAll('[data-action]')) {
    button.addEventListener('pointerdown',event=>{
      if(event.pointerType==='mouse'&&event.button!==0)return;
      event.preventDefault();if(Number(button.dataset.action)>=4&&ready&&foreground&&dialog.open)closeMenu();if(!active())return;
      canvas.focus({preventScroll:true});button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId,button);input.set('touch:'+event.pointerId,[Number(button.dataset.action)]);
    });
    button.addEventListener('pointermove',event=>{
      if(!pointers.has(event.pointerId))return;
      const target=document.elementFromPoint(event.clientX,event.clientY)?.closest('[data-action]');
      input.set('touch:'+event.pointerId,target&&active()?[Number(target.dataset.action)]:[]);
    });
    for(const event of ['pointerup','pointercancel','lostpointercapture'])button.addEventListener(event,endPointer);
    button.addEventListener('contextmenu',event=>event.preventDefault());
  }
  async function updateWake(){
    const want=running&&ready&&foreground&&preferences.wake;
    if(!want&&wakeLock){const old=wakeLock;wakeLock=null;try{await old.release();}catch(_){}return;}
    if(!want||wakeLock||wakePending||!navigator.wakeLock)return;
    wakePending=true;
    try{const lock=await navigator.wakeLock.request('screen');wakeLock=lock;lock.addEventListener('release',()=>{if(wakeLock===lock)wakeLock=null;});if(!foreground){wakeLock=null;await lock.release();}}
    catch(_){}finally{wakePending=false;}
  }
  window.OpenITGControls={diagnostics(){return {version:8,ready,running,foreground,touch:preferences.touch,enabled:preferences.gamepad,threshold:preferences.threshold,selected,pads:currentPads.map(p=>({id:p.id,index:p.index,mapping:p.mapping})),bindings:pad?bindings(pad):null};},starting(){running=true;},stop(){ready=false;input.enable(false,false);pointers.clear();updateWake();}};
  window.addEventListener('openitg-game-ready',()=>{
    ready=typeof window.OpenITGModuleInstance?._OpenITGWebInput==='function' && typeof window.OpenITGModuleInstance?._OpenITGWebReleaseKeyboard==='function';
    if(!ready)$('web-feature-status').textContent='Rebuild with the v8 native input bridge to enable touch/controllers.';
    resume();updateWake();
  });
  window.addEventListener('openitg-native-fatal',()=>{window.OpenITGControls.stop();closeSpecial();});
  window.addEventListener('webglcontextlost',()=>window.OpenITGControls.stop(),true);
  window.addEventListener('blur',()=>{foreground=false;release();input.enable(false);updateWake();});
  window.addEventListener('focus',()=>{foreground=!document.hidden;resume();updateWake();});
  document.addEventListener('visibilitychange',()=>{foreground=!document.hidden;if(!foreground)release();resume();updateWake();});
  window.addEventListener('pagehide',()=>{foreground=false;release();input.enable(false);updateWake();});
  function closeMenu(){
    dialog.open=false;window.OpenITGSettingsOpen=false;
    $('settings-button').setAttribute('aria-expanded','false');
    cancelLearn();resume();if(ready)canvas.focus({preventScroll:true});
  }
  $('settings-button').addEventListener('click',()=>{
    if(dialog.open){closeMenu();return;}
    closeSpecial();release();window.OpenITGSettingsOpen=true;dialog.open=true;
    $('settings-button').setAttribute('aria-expanded','true');resume();renderBindings();
  });
  $('close-settings').addEventListener('click',closeMenu);
  document.addEventListener('pointerdown',event=>{
    if(dialog.open&&!dialog.contains(event.target)&&!$('settings-button').contains(event.target))closeMenu();
  },true);
  $('touch-preference').value=preferences.touch;
  $('touch-preference').addEventListener('change',event=>{release();preferences.touch=event.target.value;save();touchLayout();});
  $('gamepad-enabled').checked=preferences.gamepad;
  $('gamepad-enabled').addEventListener('change',event=>{preferences.gamepad=event.target.checked;controller.reset();save();});
  $('gamepad-threshold').value=String(preferences.threshold);$('threshold-value').textContent=preferences.threshold.toFixed(2);
  $('gamepad-threshold').addEventListener('input',event=>{preferences.threshold=Number(event.target.value);$('threshold-value').textContent=preferences.threshold.toFixed(2);controller.reset();save();});
  $('gamepad-device').addEventListener('change',event=>{selected=event.target.value;controller.reset();lastBindingKey='';cancelLearn();});
  $('gamepad-cancel-learn').addEventListener('click',cancelLearn);
  $('gamepad-reset').addEventListener('click',()=>{if(pad){delete preferences.devices['pad:'+pad.id];save();cancelLearn();controller.reset();}});
  $('wake-preference').checked=preferences.wake;
  $('wake-preference').addEventListener('change',event=>{preferences.wake=event.target.checked;save();updateWake();});
  $('fullscreen-button').addEventListener('click',async()=>{
    try{
      if(document.fullscreenElement||document.webkitFullscreenElement){
        const exit=document.exitFullscreen||document.webkitExitFullscreen;
        if(exit)await exit.call(document);
        try{if(screen.orientation?.unlock)screen.orientation.unlock();}catch(_){}
        return;
      }
      const element=document.documentElement,request=element.requestFullscreen||element.webkitRequestFullscreen;
      if(!request)throw Error('Fullscreen is not supported here; use the browser’s fullscreen/Add to Home Screen option.');
      await request.call(element);
      if(screen.orientation?.lock)try{await screen.orientation.lock('landscape');}catch(_){}
      if(ready&&!dialog.open)canvas.focus({preventScroll:true});
    }catch(error){say(error.message);}
  });
  window.addEventListener('resize',touchLayout);
  function libraryNotice(state){
    lastLibraryState=state;
    if(state.message)$('library-status').textContent=state.message;
    for(const id of ['song-archive','song-folder'])$(id).disabled=!state.available||state.busy||reloadPending;
    $('library-reload').disabled=!state.available||state.busy||reloadPending;
    const list=$('library-list');list.replaceChildren();
    for(const song of state.records){
      const row=document.createElement('div');row.className='library-row';
      const text=document.createElement('span'),detail=document.createElement('small');text.textContent=song.title;detail.textContent=(song.bytes/1048576).toFixed(1)+' MiB'+(song.pendingRemove?' · removal pending reload':'');text.appendChild(detail);
      const remove=document.createElement('button');remove.textContent=song.pendingRemove?'Pending removal':'Remove';remove.disabled=state.busy||song.pendingRemove||reloadPending;
      remove.addEventListener('click',async()=>{if(reloadPending)return;try{await window.OpenITGUploads.scheduleRemove(song.id);}catch(error){$('library-status').textContent=error.message;}});
      row.append(text,remove);list.appendChild(row);
    }
    if(!state.records.length){const empty=document.createElement('p');empty.className='hint';empty.textContent='No imported songs yet. Hosted catalogue songs are not stored in this list.';list.appendChild(empty);}
  }
  window.OpenITGUploads=window.OpenITGUploadCore.library({
    sync:()=>window.OpenITGSync(false),notify:libraryNotice,
    makeID:()=> 'local-'+Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('')
  });
  for(const id of ['song-archive','song-folder']) {
    $(id).disabled=true;
    $(id).addEventListener('change',async event=>{
      if(reloadPending)return;
      const selected=Array.from(event.target.files||[]);event.target.value='';if(!selected.length)return;
      try{await window.OpenITGUploads.importFiles(selected);}
      catch(error){$('library-status').textContent='Import failed: '+error.message;}
    });
  }
  if(!('webkitdirectory' in $('song-folder')))$('folder-label').hidden=true;
  $('library-reload').disabled=true;
  $('library-reload').addEventListener('click',async()=>{
    if(window.OpenITGUploads.busy)return;
    if(!confirm('Save local data and reload? The current play session will end.'))return;
    reloadPending=true;libraryNotice(lastLibraryState);release();
    try{await window.OpenITGSync(false);location.reload();}catch(error){reloadPending=false;libraryNotice(lastLibraryState);$('library-status').textContent='Save failed; did not reload: '+error.message;resume();}
  });
  libraryNotice({available:false,busy:false,records:[]});touchLayout();renderBindings();requestAnimationFrame(poll);
})();

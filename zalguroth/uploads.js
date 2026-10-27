/* Local-only static SM library. No server upload, executable song scripts or
 * live SongManager pointer replacement. ZIP parsing is bounded before inflate. */
(function(root) {
  'use strict';
  const MiB = 1048576;
  const limits = { archive:32*MiB, file:32*MiB, batch:64*MiB, library:128*MiB, count:1000, chart:8*MiB };
  const ROOT = '/persistent/Songs/Browser Uploads';
  const META = '/persistent/WebUploads';
  const INDEX = META + '/index.json';
  const ID = /^local-[a-f0-9]{32}$/;
  const allowed = new Set(['sm','ogg','mp3','wav','png','jpg','jpeg','gif','bmp','lrc','txt']);
  const audio = new Set(['ogg','mp3','wav']);
  const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', {fatal:true});
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  function path(value) {
    value = String(value).replace(/\\/g,'/');
    if (value.endsWith('/')) value = value.slice(0,-1);
    if (!value || value.length > 400 || /[\x00-\x1f\x7f:]/.test(value) || value.split('/').some(p => !p || p === '.' || p === '..'))
      throw Error('Unsafe/unsupported archive path: ' + value);
    return value;
  }
  function ignored(p) { return p.split('/').some(s => s === '__MACOSX' || s.startsWith('._')) || /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(p); }
  function extension(p) { return p.split('.').pop().toLowerCase(); }
  const crcTable = new Uint32Array(256);
  for (let n=0;n<256;n++) { let c=n; for(let k=0;k<8;k++) c=(c&1)?0xedb88320^(c>>>1):c>>>1; crcTable[n]=c>>>0; }
  function crc(bytes, value=0xffffffff) { for (let i=0;i<bytes.length;i++) value=crcTable[(value^bytes[i])&255]^(value>>>8); return value>>>0; }
  async function unzip(bytes, progress=()=>{}) {
    if (bytes.length > limits.archive) throw Error('ZIP limit is 32 MiB. Import a smaller pack.');
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = n => v.getUint16(n,true), u32 = n => v.getUint32(n,true);
    let end = -1;
    for(let n=bytes.length-22;n>=Math.max(0,bytes.length-65557);n--) {
      if(u32(n)===0x06054b50 && n+22+u16(n+20)===bytes.length) {end=n;break;}
    }
    if(end<0) throw Error('Not a complete ZIP/SMZIP archive.');
    const count=u16(end+10), central=u32(end+16), centralSize=u32(end+12);
    if(u16(end+4)||u16(end+6)||u16(end+8)!==count||count===65535||central===0xffffffff||centralSize===0xffffffff)
      throw Error('Split/ZIP64 archives are not supported. Re-zip a smaller pack.');
    if(count>limits.count || central+centralSize>end) throw Error('Archive has too many files or an invalid directory.');
    const entries=[], seen=new Set(); let cursor=central,total=0;
    for(let i=0;i<count;i++) {
      if(cursor+46>central+centralSize || u32(cursor)!==0x02014b50) throw Error('Invalid ZIP directory entry.');
      const flags=u16(cursor+8), method=u16(cursor+10), checksum=u32(cursor+16), compressed=u32(cursor+20), size=u32(cursor+24);
      const nameLength=u16(cursor+28), extra=u16(cursor+30), comment=u16(cursor+32), local=u32(cursor+42);
      if(cursor+46+nameLength+extra+comment>central+centralSize) throw Error('Truncated ZIP metadata.');
      if(flags&1 || (method!==0&&method!==8) || ((u32(cursor+38)>>>16)&0xf000)===0xa000 || u16(cursor+34))
        throw Error('Encrypted, symlink, split or unsupported ZIP entry.');
      const rawName=decoder.decode(bytes.subarray(cursor+46,cursor+46+nameLength));
      const name=path(rawName), directory=rawName.endsWith('/');
      if(seen.has(name.toLowerCase())) throw Error('Duplicate/case-conflicting ZIP path: '+name);
      seen.add(name.toLowerCase());
      if(size>limits.file || compressed>limits.archive || (total+=size)>limits.batch) throw Error('Import limit: 32 MiB/file, 64 MiB uncompressed per batch.');
      if(local+30>central || u32(local)!==0x04034b50 || u16(local+8)!==method || u16(local+6)!==flags) throw Error('Invalid ZIP local header.');
      const start=local+30+u16(local+26)+u16(local+28);
      if(start>central || start+compressed>central || path(decoder.decode(bytes.subarray(local+30,local+30+u16(local+26))))!==name)
        throw Error('ZIP local path/data does not match its directory.');
      if(!directory&&!ignored(name)) entries.push({path:name,method,checksum,compressed,size,start});
      cursor+=46+nameLength+extra+comment;
    }
    if(cursor!==central+centralSize) throw Error('Unexpected ZIP directory data.');
    const output=[];
    for(const entry of entries) {
      progress('Reading '+entry.path); await tick();
      let out, checksum=0xffffffff;
      if(entry.method===0) {
        if(entry.compressed!==entry.size) throw Error('Invalid stored ZIP size.');
        out=bytes.slice(entry.start,entry.start+entry.size); checksum=crc(out);
      } else {
        if(!root.fflate) throw Error('Missing local ZIP decoder. Upload shell/vendor/fflate.js.');
        out=new Uint8Array(entry.size); let offset=0,finished=false;
        const inflate=new root.fflate.Inflate((chunk,final)=>{
          if(offset+chunk.length>entry.size) throw Error('ZIP expands beyond its declared size.');
          out.set(chunk,offset); offset+=chunk.length; checksum=crc(chunk,checksum); finished=final;
        });
        // A small compressed chunk bounds each inflate allocation, even if a
        // malicious ZIP lies about its uncompressed size in the directory.
        for(let i=0;i<entry.compressed;i+=2048) {
          const last=Math.min(i+2048,entry.compressed);
          inflate.push(bytes.subarray(entry.start+i,entry.start+last),last===entry.compressed);
          if((i/2048)%8===0) await tick();
        }
        if(!finished||offset!==entry.size) throw Error('Incomplete ZIP inflation.');
      }
      if(((checksum^0xffffffff)>>>0)!==entry.checksum) throw Error('ZIP CRC mismatch: '+entry.path);
      output.push({path:entry.path,bytes:out});
    }
    return output;
  }
  function validateImage(file) {
    const b=file.bytes,v=new DataView(b.buffer,b.byteOffset,b.byteLength);
    let width=0,height=0;
    if(b.length>=24&&b[0]===137&&b[1]===80&&b[2]===78&&b[3]===71){width=v.getUint32(16);height=v.getUint32(20);}
    else if(b.length>=26&&b[0]===66&&b[1]===77){width=v.getInt32(18,true);height=Math.abs(v.getInt32(22,true));}
    else if(b.length>=13&&b[0]===71&&b[1]===73&&b[2]===70){
      width=v.getUint16(6,true);height=v.getUint16(8,true);
      let at=13+((b[10]&128)?3*(1<<((b[10]&7)+1)):0),frames=0;
      function blocks(){while(at<b.length){const n=b[at++];if(!n)return;at+=n;if(at>b.length)throw Error('Truncated GIF: '+file.path);}throw Error('Truncated GIF: '+file.path);}
      while(at<b.length){const marker=b[at++];if(marker===59)break;
        if(marker===33){at++;blocks();}
        else if(marker===44){
          if(at+9>b.length)throw Error('Truncated GIF image.');
          const fw=v.getUint16(at+4,true),fh=v.getUint16(at+6,true),packed=b[at+8];
          if(!fw||!fh||fw>4096||fh>4096)throw Error('GIF frame is too large.');
          if(++frames>1)throw Error('Animated GIF uploads are not supported; convert to a static PNG.');
          at+=9+((packed&128)?3*(1<<((packed&7)+1)):0);at++;blocks();
        }else throw Error('Invalid GIF: '+file.path);
      }
      if(!frames)throw Error('GIF contains no image.');
    }else if(b.length>=4&&b[0]===255&&b[1]===216){
      let at=2;
      while(at+3<b.length){
        if(b[at++]!==255)throw Error('Invalid JPEG: '+file.path);
        while(b[at]===255)at++;
        const marker=b[at++];if(marker===217||marker===218)break;
        if(marker===1||(marker>=208&&marker<=215))continue;
        if(at+2>b.length)break;const size=v.getUint16(at);
        if(size<2||at+size>b.length)break;
        if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&size>=7){height=v.getUint16(at+3);width=v.getUint16(at+5);break;}
        at+=size;
      }
    }
    if(width<1||height<1||width>4096||height>4096||width*height>16000000)
      throw Error('Invalid/oversized image (maximum 4096px per side and 16 megapixels): '+file.path);
  }
  function plan(entries) {
    const seen=new Set(),directories=new Map(); let total=0;
    for(const e of entries) {
      e.path=path(e.path);
      if(seen.has(e.path.toLowerCase())) throw Error('Duplicate/case-conflicting file: '+e.path);
      seen.add(e.path.toLowerCase());
      const parts=e.path.split('/');let parent='';
      for(const part of parts.slice(0,-1)){parent+=(parent?'/':'')+part;const previous=directories.get(parent.toLowerCase());if(previous&&previous!==parent)throw Error('Case-conflicting directory: '+parent);directories.set(parent.toLowerCase(),parent);}
      if(e.bytes.length>limits.file||(total+=e.bytes.length)>limits.batch||entries.length>limits.count) throw Error('Batch/file count or size limit exceeded.');
    }
    entries=entries.filter(e=>!ignored(e.path));
    const charts=entries.filter(e=>extension(e.path)==='sm');
    if(!charts.length) throw Error('No .sm chart found. Extract/convert your songs to SM first.');
    const roots=charts.map(e=>e.path.includes('/')?e.path.slice(0,e.path.lastIndexOf('/')):'');
    for(let i=0;i<roots.length;i++) for(let j=i+1;j<roots.length;j++)
      if(roots[i]===roots[j]||!roots[i]||!roots[j]||roots[i].startsWith(roots[j]+'/')||roots[j].startsWith(roots[i]+'/'))
        throw Error('Use one .sm file per separate song folder (no nested song folders).');
    const songs=[], warnings=[];
    charts.forEach((chart,n)=>{
      if(chart.bytes.length>limits.chart) throw Error('Chart exceeds 8 MiB: '+chart.path);
      const prefix=roots[n]?roots[n]+'/':'';
      const files=entries.filter(e=>e.path.startsWith(prefix)).map(e=>({path:e.path.slice(prefix.length),bytes:e.bytes}));
      if(files.some(e=>e.path.split('/').some(p=>p==='.web-preview.ogg'||p==='.web-full-chart.dat'))) throw Error('Import original full songs, not a generated web package.');
      let text=decoder.decode(chart.bytes);
      const clean=text.replace(/\/\/[^\r\n]*/g,'');
      const notes=[...clean.matchAll(/#NOTES\s*:(.*?);/gis)];
      if(!notes.length||notes.some(m=>m[1].split(':').length!==6)) throw Error('Malformed SM NOTES in '+chart.path);
      const tags=Object.create(null);
      for(const m of clean.matchAll(/#([A-Z0-9_]+)\s*:(.*?);/gis)) tags[m[1].toUpperCase()]=m[2].trim();
      if(tags.KEYSOUNDS) throw Error('Keysound/script-dependent songs are not supported by the static importer.');
      const find=value=>files.find(e=>e.path.toLowerCase()===path(value).toLowerCase());
      let music;
      if(tags.MUSIC) music=find(tags.MUSIC);
      else {const candidates=files.filter(e=>audio.has(extension(e.path)));if(candidates.length===1) music=candidates[0];}
      if(!music||!audio.has(extension(music.path))||!music.bytes.length) throw Error('Missing/ambiguous self-contained OGG/MP3/WAV music: '+chart.path);
      const replaceTag=(tag,value)=>{const re=new RegExp('#'+tag+'\\s*:.*?;','gis');text=re.test(text)?text.replace(re,()=> '#'+tag+':'+value+';'):'#'+tag+':'+value+';\n'+text;};
      replaceTag('MUSIC',music.path);
      for(const tag of ['BANNER','CDTITLE','BACKGROUND','LYRICSPATH']) if(tags[tag]) {
        let asset; try {asset=find(tags[tag]);} catch(_) {}
        if(asset&&allowed.has(extension(asset.path))) replaceTag(tag,asset.path);
        else {replaceTag(tag,'');warnings.push('Ignored missing/external '+tag+' in '+chart.path);}
      }
      // Local uploads are static songs. Do not install Lua/actor/BGA scripts
      // or let external background/foreground references escape the folder.
      text=text.replace(/#(?:BGCHANGES\d*|FGCHANGES|ANIMATIONS)\s*:.*?;/gis,'');
      const installed=files.filter(e=>allowed.has(extension(e.path)));
      for(const file of installed)if(['png','jpg','jpeg','gif','bmp'].includes(extension(file.path)))validateImage(file);
      if(installed.length!==files.length) warnings.push('Skipped scripts/videos/unsupported extras in '+chart.path);
      const outChart=installed.find(e=>extension(e.path)==='sm');outChart.bytes=encoder.encode(text);
      const title=(tags.TITLE||roots[n].split('/').pop()||'Uploaded song').replace(/[\x00-\x1f]/g,' ').slice(0,200);
      songs.push({title,files:installed,bytes:installed.reduce((sum,e)=>sum+e.bytes.length,0)});
    });
    if(songs.reduce((sum,s)=>sum+s.bytes,0)>limits.batch) throw Error('Prepared songs exceed the 64 MiB batch limit.');
    return {songs,warnings};
  }
  function library({sync,notify=()=>{},makeID}) {
    let FS=null,records=[],available=false,busy=false;
    function publish(message) { notify({available,busy,records:records.map(r=>({...r})),message}); }
    function exists(p) { try {FS.stat(p);return true;} catch(_){return false;} }
    function remove(p) { if(!exists(p))return;const stat=FS.lstat?FS.lstat(p):FS.stat(p);if(FS.isLink&&FS.isLink(stat.mode)){FS.unlink(p);return;}if(FS.isDir(stat.mode)){for(const child of FS.readdir(p))if(child!=='.'&&child!=='..')remove(p+'/'+child);FS.rmdir(p);}else FS.unlink(p); }
    function saveIndex() {FS.mkdirTree(META);FS.writeFile(INDEX,encoder.encode(JSON.stringify({version:1,songs:records})));}
    function validate(data) {
      if(!data||data.version!==1||!Array.isArray(data.songs)||data.songs.length>500)throw Error('Local library index is invalid. No library files were deleted.');
      const ids=new Set();
      for(const r of data.songs) {
        if(!r||!ID.test(r.id)||ids.has(r.id)||typeof r.title!=='string'||r.title.length>200||!Number.isSafeInteger(r.bytes)||r.bytes<0||r.bytes>limits.batch)throw Error('Invalid local song index entry.');
        if(r.pendingRemove!==undefined&&typeof r.pendingRemove!=='boolean')throw Error('Invalid removal marker.');
        ids.add(r.id);
      }
      return data.songs;
    }
    return {
      get busy(){return busy;}, get available(){return available;},
      diagnostics(){return {available,busy,songs:records.map(r=>({id:r.id,title:r.title,bytes:r.bytes,pendingRemove:!!r.pendingRemove}))};},
      unavailable(message){available=false;publish(message);},
      async restore(fs) {
        FS=fs;FS.mkdirTree(ROOT);FS.mkdirTree(META);records=exists(INDEX)?validate(JSON.parse(decoder.decode(FS.readFile(INDEX)))):[];
        let changed=false;
        for(const r of records.filter(r=>r.pendingRemove)){remove(ROOT+'/'+r.id);changed=true;}
        records=records.filter(r=>!r.pendingRemove);
        const ids=new Set(records.map(r=>r.id));
        for(const name of FS.readdir(ROOT))if(ID.test(name)&&!ids.has(name)){remove(ROOT+'/'+name);changed=true;}
        if(exists(META+'/staging')){remove(META+'/staging');changed=true;}
        if(changed){saveIndex();await sync();}
        available=true;publish('Local library ready.');
      },
      async importFiles(selected) {
        if(!available||busy)throw Error('Wait until local storage is ready and other library work finishes.');
        busy=true;publish('Validating local songs…');
        const old=records.map(r=>({...r})),created=[];
        try {
          let entries=[],selectedTotal=0;
          if(!selected.length||selected.length>limits.count)throw Error('Select a song ZIP/SMZIP or folder (maximum 1,000 files).');
          for(const file of selected) {
            if((selectedTotal+=file.size)>limits.batch)throw Error('Selected files exceed 64 MiB.');
            if(/\.(?:zip|smzip)$/i.test(file.name)&&!file.webkitRelativePath) {
              if(file.size>limits.archive)throw Error('ZIP limit is 32 MiB.');
              entries.push(...await unzip(new Uint8Array(await file.arrayBuffer()),publish));
            } else {
              if(file.size>limits.file)throw Error('Individual file limit is 32 MiB.');
              entries.push({path:file.webkitRelativePath||file.name,bytes:new Uint8Array(await file.arrayBuffer())});
            }
          }
          const prepared=plan(entries);
          if(records.length+prepared.songs.length>500)throw Error('Local library limit is 500 songs.');
          const incoming=prepared.songs.reduce((sum,s)=>sum+s.bytes,0);
          if(records.reduce((sum,r)=>sum+r.bytes,0)+incoming>limits.library)throw Error('Local library limit is 128 MiB. Remove songs and reload before importing more.');
          for(const song of prepared.songs) {
            const id=makeID();if(!ID.test(id)||exists(ROOT+'/'+id))throw Error('Could not allocate a unique local song folder.');
            const staging=META+'/staging/'+id;FS.mkdirTree(staging);
            for(const file of song.files) {
              const dest=staging+'/'+file.path;FS.mkdirTree(dest.slice(0,dest.lastIndexOf('/')));FS.writeFile(dest,file.bytes);await tick();
            }
            FS.rename(staging,ROOT+'/'+id);created.push(id);
            records.push({id,title:song.title,bytes:song.bytes,files:song.files.length,created:new Date().toISOString()});
          }
          saveIndex();publish('Saving songs on this device…');await sync();
          publish('Imported '+created.length+' song(s). Reload to refresh the game library.'+(prepared.warnings.length?' '+prepared.warnings.join(' | '):''));
          return created.length;
        } catch(error) {
          records=old;
          for(const id of created)remove(ROOT+'/'+id);
          remove(META+'/staging');
          saveIndex();
          try{await sync();}catch(_){}
          publish('Import failed: '+error.message);throw error;
        } finally {busy=false;publish();}
      },
      async scheduleRemove(id) {
        if(!available||busy)throw Error('Wait for local library work to finish.');
        const r=records.find(r=>r.id===id);if(!r)throw Error('Unknown local song.');
        busy=true;const previous=!!r.pendingRemove;
        try{r.pendingRemove=true;saveIndex();publish('Saving removal request…');await sync();publish('Removal saved. Reload to apply safely; the current game retains its files.');}
        catch(error){r.pendingRemove=previous;saveIndex();try{await sync();}catch(_){}throw error;}
        finally{busy=false;publish();}
      }
    };
  }
  root.OpenITGUploadCore={limits,path,unzip,plan,library};
})(typeof window!=='undefined'?window:globalThis);

/* thingie: canvas — full app.js (Supabase + fallback)
   - Boot-proof config (supabase.config.js OR window vars; else local-only)
   - Supabase Realtime: presence (cursors), chat, broadcast ops
   - Persistence: room scene JSON in `rooms` table
   - Undo/Redo (vectors), Pan/Zoom, Multi-select, Table insert row/col
   - Text boxes: rich toolbar (H1/H2/B/I/Color), auto-return to Select
*/

// -------- Config (boot-proof) --------
let SUPABASE_URL = "";
let SUPABASE_ANON_KEY = "";
try {
  const mod = await import('./supabase.config.js'); // generated at build
  SUPABASE_URL = mod.SUPABASE_URL || "";
  SUPABASE_ANON_KEY = mod.SUPABASE_ANON_KEY || "";
} catch (e) {
  console.warn("supabase.config.js not found; falling back to window vars/local mode.");
}
if (!SUPABASE_URL && window.SUPABASE_URL) SUPABASE_URL = window.SUPABASE_URL;
if (!SUPABASE_ANON_KEY && window.SUPABASE_ANON_KEY) SUPABASE_ANON_KEY = window.SUPABASE_ANON_KEY;

// -------- DOM helpers --------
const $ = (s, r=document)=>r.querySelector(s);
const $$ = (s, r=document)=>Array.from(r.querySelectorAll(s));
const COLORS=["#5096FF","#3CBE8C","#F25050","#FCD23C","#172033"];

// -------- Elements --------
const bitmap=$('#bitmap'), bctx=bitmap.getContext('2d');
const svg=$('#svg');
const overlay=$('#overlay');
const cursors=$('#cursors');
const marquee=$('#marquee');
const viewport=$('#viewport');

const dlg=$('#welcome'), nameInput=$('#displayName'), roomInput=$('#roomInput');
const chatToggle=$('#chatToggle'), chatPanel=$('#chatPanel'), chatClose=$('#chatClose');
const chatForm=$('#chatForm'), chatInput=$('#chatInput'), chatLog=$('#chatLog');

// -------- State --------
let supabase=null, sbChannel=null, bcChannel=null;
let state={
  tool:'select', color:'#172033', size:4,
  name:'', userId:(Math.random()*1e9|0).toString(36), colorIdx:Math.floor(Math.random()*4),
  room:null,
  pan:{x:0,y:0,scale:1, panning:false, panStart:{x:0,y:0}, panFrom:{x:0,y:0}},
  selection:new Set(),
  undo:[], redo:[],
  drawing:false, start:null, currentPath:null
};

// -------- Utils --------
function randomCode(len=6){ const c='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; return Array.from({length:len},()=>c[Math.random()*c.length|0]).join(''); }
function applyTransform(){ viewport.style.transform=`translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.pan.scale})`; }
function stagePos(evt){
  const rect=viewport.getBoundingClientRect(), s=state.pan.scale;
  return { x:(evt.clientX-rect.left - state.pan.x)/s, y:(evt.clientY-rect.top - state.pan.y)/s };
}

// -------- Supabase (optional) --------
async function initSupabase(){
  if(!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { realtime:{ params:{ eventsPerSecond: 10 } } });
}
async function saveSceneToSupabase(s){
  if(!supabase) return;
  await supabase.from('rooms').upsert({ code: state.room, scene: s });
}
async function loadSceneFromSupabase(){
  if(!supabase) return false;
  const { data, error } = await supabase.from('rooms').select('scene').eq('code', state.room).maybeSingle();
  if(!error && data?.scene){ hydrate(data.scene, true); return true; }
  return false;
}

// -------- Transport (Supabase + BroadcastChannel fallback) --------
function send(type, payload){
  const data={type, payload:{...payload, room:state.room, userId:state.userId}};
  bcChannel && bcChannel.postMessage(data);
  sbChannel && sbChannel.send({ type:'broadcast', event:'msg', payload:data });
}
function onMessage(e){
  const {type, payload}=e.data||{}; if(payload?.userId===state.userId) return;
  if(type==='cursor') return renderRemoteCursor(payload);
  if(type==='scene-sync') return hydrate(payload.scene, true);
  if(type==='sync-request') return broadcastScene();
  if(type==='add') return addRemote(payload);
  if(type==='update') return updateRemote(payload);
  if(type==='delete') return deleteRemote(payload.id);
  if(type==='chat') return appendChat(payload);
}
async function connect(room){
  // BroadcastChannel (tabs)
  bcChannel = new BroadcastChannel('thingie-'+room);
  bcChannel.onmessage = onMessage;

  // Supabase Realtime
  if(supabase){
    sbChannel = supabase.channel('room:'+room, { config: { broadcast:{ack:true}, presence:{ key: state.userId } } });
    sbChannel.on('broadcast', {event:'msg'}, (ev)=> onMessage({data: ev.payload}));
    sbChannel.on('presence', {event:'sync'}, ()=>{/* presence list available via sbChannel.presenceState() if needed */});
    await sbChannel.subscribe(async (status)=>{
      if(status==='SUBSCRIBED'){
        await sbChannel.track({ userId: state.userId, name: state.name, color: COLORS[state.colorIdx] });
        const had = await loadSceneFromSupabase();
        if(!had) loadPersisted();
        send('sync-request',{});
      }
    });
  } else {
    // local fallback
    loadPersisted();
    send('sync-request',{});
  }
}

// -------- Scene & persistence --------
function roomKey(){ return 'thingie-scene-'+state.room; }
function scene(){
  return {
    vectors: Array.from(svg.children).map(el=>el.outerHTML),
    texts: $$('.textbox', overlay).map(el=>serializeText(el)),
    tables: $$('.table', overlay).map(el=>serializeTable(el)),
    bitmap: bitmap.toDataURL('image/png')
  };
}
function persist(){ const s=scene(); localStorage.setItem(roomKey(), JSON.stringify(s)); saveSceneToSupabase(s); }
function hydrate(s, applyBitmap=true){
  svg.innerHTML=''; overlay.innerHTML='';
  if(applyBitmap && s.bitmap){
    const img=new Image(); img.onload=()=>{ bctx.clearRect(0,0,bitmap.width,bitmap.height); bctx.drawImage(img,0,0); }; img.src=s.bitmap;
  }
  (s.vectors||[]).forEach(html=>{ const el=new DOMParser().parseFromString(html,'image/svg+xml').documentElement; svg.appendChild(el); attachVectorHandlers(el); });
  (s.texts||[]).forEach(addTextboxFromSerialized);
  (s.tables||[]).forEach(addTableFromSerialized);
}
function loadPersisted(){ const raw=localStorage.getItem(roomKey()); if(!raw) return; try{ hydrate(JSON.parse(raw), true); }catch{} }
function broadcastScene(){ send('scene-sync', {scene: scene()}); }

// -------- UI boot --------
chatToggle.onclick=()=> chatPanel.hidden = !chatPanel.hidden;
chatClose.onclick=()=> chatPanel.hidden = true;
chatForm.addEventListener('submit', (e)=>{ e.preventDefault(); const text=chatInput.value.trim(); if(!text) return; send('chat',{user:state.name,text}); appendChat({user:state.name,text}); chatInput.value=''; });
function appendChat(m){ const div=document.createElement('div'); div.className='chat-item'; div.textContent=`${m.user}: ${m.text}`; chatLog.appendChild(div); chatLog.scrollTop=chatLog.scrollHeight; }

$('#createBtn').addEventListener('click', e=>{ e.preventDefault(); const n=nameInput.value.trim(); if(!n) return; start(randomCode(), n); dlg.close(); });
$('#joinBtn').addEventListener('click', e=>{ e.preventDefault(); const n=nameInput.value.trim(); if(!n) return; const code=(roomInput.value||'').trim().toUpperCase(); if(!code) return; start(code, n); dlg.close(); });

const urlCode=location.hash.replace('#','').toUpperCase();
boot();
async function boot(){
  await initSupabase();
  if(!urlCode){ dlg.showModal(); } else { start(urlCode); }
}
function start(code, name){
  state.name=name||state.name||'Guest';
  if(!location.hash) location.hash=code;
  state.room=code;
  $('#roomCode').textContent=code;
  connect(code);
}

// -------- Tools --------
$$('.tool').forEach(b=> b.addEventListener('click',()=>{ $$('.tool').forEach(x=>x.setAttribute('aria-pressed','false')); b.setAttribute('aria-pressed','true'); state.tool=b.dataset.tool; }));
$('#colorPicker').addEventListener('input', e=> state.color=e.target.value);
$('#sizePicker').addEventListener('input', e=> state.size=+e.target.value);

// -------- Pan/Zoom/Undo --------
document.addEventListener('keydown', (e)=>{
  if(e.key===' '){ state.pan.panning=true; state.pan.panFrom={...state.pan}; }
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z'){ e.preventDefault(); if(e.shiftKey) redo(); else undo(); }
  if((e.ctrlKey||e.metaKey) && e.key==='0'){ state.pan.scale=1; state.pan.x=0; state.pan.y=0; applyTransform(); }
});
document.addEventListener('keyup', (e)=>{ if(e.key===' ') state.pan.panning=false; });
$('#stage').addEventListener('wheel', (e)=>{
  if(e.ctrlKey || e.metaKey){ e.preventDefault();
    const delta=-e.deltaY*0.0015, old=state.pan.scale;
    state.pan.scale = Math.min(3, Math.max(0.25, old*(1+delta)));
    applyTransform();
  }
},{passive:false});
$('#stage').addEventListener('pointerdown', e=>{
  if(state.pan.panning){ state.pan.panStart={x:e.clientX,y:e.clientY}; e.preventDefault(); }
});
$('#stage').addEventListener('pointermove', e=>{
  if(state.pan.panning){
    const dx=e.clientX-state.pan.panStart.x, dy=e.clientY-state.pan.panStart.y;
    state.pan.x = state.pan.panFrom.x + dx; state.pan.y = state.pan.panFrom.y + dy; applyTransform();
  }
});

function pushUndo(){ state.undo.push(serializeVectors()); state.redo.length=0; }
function undo(){ if(!state.undo.length) return; const prev=state.undo.pop(); const cur=serializeVectors(); state.redo.push(cur); restoreVectors(prev); persist(); broadcastScene(); }
function redo(){ if(!state.redo.length) return; const next=state.redo.pop(); const cur=serializeVectors(); state.undo.push(cur); restoreVectors(next); persist(); broadcastScene(); }
function serializeVectors(){ return Array.from(svg.children).map(el=>el.outerHTML); }
function restoreVectors(list){ svg.innerHTML=''; (list||[]).forEach(html=>{ const el=new DOMParser().parseFromString(html,'image/svg+xml').documentElement; svg.appendChild(el); attachVectorHandlers(el); }); }

// -------- Drawing & selection --------
function starPath(x0,y0,x1,y1){ const cx=(x0+x1)/2, cy=(y0+y1)/2; const R=Math.hypot(x1-x0,y1-y0)/2, r=R/2.5, n=5; let rot=Math.PI/2*3; let d=`M ${cx} ${cy-R}`; for(let i=0;i<n;i++){ d+=` L ${cx+Math.cos(rot)*R} ${cy+Math.sin(rot)*R}`; rot+=Math.PI/n; d+=` L ${cx+Math.cos(rot)*r} ${cy+Math.sin(rot)*r}`; rot+=Math.PI/n; } return d+' Z'; }
function blobPath(x0,y0,x1,y1){ const x=Math.min(x0,x1), y=Math.min(y0,y1), w=Math.abs(x1-x0), h=Math.abs(y1-y0); return `M ${x} ${y+h*0.3} C ${x} ${y} ${x+w*0.4} ${y} ${x+w*0.6} ${y+h*0.2} C ${x+w} ${y+h*0.4} ${x+w*0.8} ${y+h} ${x+w*0.5} ${y+h*0.9} C ${x+w*0.2} ${y+h*0.8} ${x+w*0.2} ${y+h*0.5} ${x} ${y+h*0.3} Z`; }

function pointerDown(e){
  const {x,y}=stagePos(e); state.drawing=true; state.start={x,y};
  if(state.tool==='select'){
    marquee.hidden=false; marquee.style.left=x+'px'; marquee.style.top=y+'px'; marquee.style.width='0px'; marquee.style.height='0px';
    return;
  }
  pushUndo();
  if(state.tool==='pen' || state.tool==='eraser'){
    const path=document.createElementNS('http://www.w3.org/2000/svg','path');
    path.setAttribute('d',`M ${x} ${y}`); path.setAttribute('fill','none');
    path.setAttribute('stroke', state.tool==='eraser' ? '#FFFFFF' : state.color);
    path.setAttribute('stroke-width', state.size);
    path.setAttribute('stroke-linecap','round'); path.setAttribute('stroke-linejoin','round');
    path.dataset.id='v_'+Math.random().toString(36).slice(2); path.dataset.type='stroke';
    svg.appendChild(path); attachVectorHandlers(path); state.currentPath=path; send('add',{kind:'vector', html:path.outerHTML});
  } else if(['rect','circle','star','blob'].includes(state.tool)){
    const id='v_'+Math.random().toString(36).slice(2); let el;
    if(state.tool==='rect'){
      el=document.createElementNS('http://www.w3.org/2000/svg','rect');
      el.setAttribute('x',x); el.setAttribute('y',y); el.setAttribute('width',1); el.setAttribute('height',1);
      el.setAttribute('fill', state.color+'44'); el.setAttribute('stroke', state.color); el.setAttribute('stroke-width',2);
    } else if(state.tool==='circle'){
      el=document.createElementNS('http://www.w3.org/2000/svg','ellipse');
      el.setAttribute('cx',x); el.setAttribute('cy',y); el.setAttribute('rx',1); el.setAttribute('ry',1);
      el.setAttribute('fill', state.color+'44'); el.setAttribute('stroke', state.color); el.setAttribute('stroke-width',2);
    } else {
      el=document.createElementNS('http://www.w3.org/2000/svg','path');
      el.setAttribute('d',`M ${x} ${y}`); el.setAttribute('fill', state.color+'44'); el.setAttribute('stroke', state.color); el.setAttribute('stroke-width',2);
    }
    el.dataset.id=id; el.dataset.type=state.tool; svg.appendChild(el); attachVectorHandlers(el); state.currentPath=el;
  }
}
function pointerMove(e){
  const {x,y}=stagePos(e);
  renderLocalCursor(x,y); send('cursor',{x,y,color:COLORS[state.colorIdx],name:state.name});
  if(!state.drawing) return;
  if(state.tool==='select'){
    marquee.style.left=Math.min(x,state.start.x)+'px';
    marquee.style.top=Math.min(y,state.start.y)+'px';
    marquee.style.width=Math.abs(x-state.start.x)+'px';
    marquee.style.height=Math.abs(y-state.start.y)+'px';
    return;
  }
  const el=state.currentPath;
  if(!el) return;
  if(el.dataset.type==='stroke'){
    el.setAttribute('d', el.getAttribute('d')+` L ${x} ${y}`);
  } else if(el.dataset.type==='rect'){
    el.setAttribute('x', Math.min(x,state.start.x));
    el.setAttribute('y', Math.min(y,state.start.y));
    el.setAttribute('width', Math.abs(x-state.start.x));
    el.setAttribute('height', Math.abs(y-state.start.y));
  } else if(el.dataset.type==='circle'){
    el.setAttribute('cx', (x+state.start.x)/2);
    el.setAttribute('cy', (y+state.start.y)/2);
    el.setAttribute('rx', Math.abs(x-state.start.x)/2);
    el.setAttribute('ry', Math.abs(y-state.start.y)/2);
  } else if(el.dataset.type==='star'){
    el.setAttribute('d', starPath(state.start.x,state.start.y,x,y));
  } else if(el.dataset.type==='blob'){
    el.setAttribute('d', blobPath(state.start.x,state.start.y,x,y));
  }
}
function pointerUp(){
  if(state.tool==='select'){
    marquee.hidden=true;
    const x=parseFloat(marquee.style.left)||0, y=parseFloat(marquee.style.top)||0, w=parseFloat(marquee.style.width)||0, h=parseFloat(marquee.style.height)||0;
    selectWithinRect(x,y,w,h); state.drawing=false; state.start=null; return;
  }
  if(state.currentPath){
    send('update',{id: state.currentPath.dataset.id, html: state.currentPath.outerHTML});
    persist(); broadcastScene(); state.currentPath=null;
  }
  state.drawing=false; state.start=null;
}
['pointerdown','pointermove','pointerup'].forEach(t=>{
  svg.addEventListener(t, (e)=>{ if(e.button===2) return; if(t!=='pointermove') e.preventDefault(); (t==='pointerdown'?pointerDown:(t==='pointermove'?pointerMove:pointerUp))(e); });
  bitmap.addEventListener(t, (e)=>{ if(e.button===2) return; if(t!=='pointermove') e.preventDefault(); (t==='pointerdown'?pointerDown:(t==='pointermove'?pointerMove:pointerUp))(e); });
});

// -------- Vector selection/drag (multi) --------
function attachVectorHandlers(el){
  el.style.pointerEvents='stroke';
  el.addEventListener('pointerdown', (e)=>{
    if(state.tool!=='select') return;
    e.stopPropagation();
    if(!e.shiftKey) clearSelection();
    el.classList.add('selected'); state.selection.add(el);
    const start=stagePos(e);
    const snaps=new Map(); state.selection.forEach(it=> snaps.set(it, it.getAttribute('transform')||''));
    const onMove=(ev)=>{ const p=stagePos(ev), dx=p.x-start.x, dy=p.y-start.y;
      state.selection.forEach(it=> it.setAttribute('transform', (snaps.get(it)||'')+` translate(${dx},${dy})`));
    };
    const onUp=()=>{ window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); persist(); broadcastScene(); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  });
}
function selectWithinRect(x,y,w,h){
  Array.from(svg.children).forEach(el=>{ const b=el.getBBox(); if(b.x>=x && b.y>=y && (b.x+b.width)<=x+w && (b.y+b.height)<=y+h){ el.classList.add('selected'); state.selection.add(el); }});
  $$('.item', overlay).forEach(el=>{ const ex=parseFloat(el.style.left)||0, ey=parseFloat(el.style.top)||0, ew=el.offsetWidth, eh=el.offsetHeight;
    if(ex>=x && ey>=y && (ex+ew)<=x+w && (ey+eh)<=y+h){ el.classList.add('selected'); state.selection.add(el); }});
}
function clearSelection(){ state.selection.forEach(el=>el.classList?.remove('selected')); state.selection.clear(); }
document.addEventListener('keydown', (e)=>{
  if(e.key==='Delete' || e.key==='Backspace'){
    state.selection.forEach(el=>{ const id=el.dataset.id; el.remove(); send('delete',{id}); });
    state.selection.clear(); persist(); broadcastScene();
  }
});

// -------- Cursors (presence) --------
function renderLocalCursor(x,y){
  let el=$('#cursor-local'); if(!el){ el=document.createElement('div'); el.id='cursor-local'; el.className='cursor';
    const a=document.createElement('div'); a.className='arrow'; a.style.borderTopColor=COLORS[state.colorIdx]; el.appendChild(a); cursors.appendChild(el);
  } el.style.left=x+'px'; el.style.top=y+'px';
}
function renderRemoteCursor(p){
  let el=$('#cur_'+(p.userId||'x'));
  if(!el){ el=document.createElement('div'); el.id='cur_'+(p.userId||Math.random()); el.className='cursor';
    const a=document.createElement('div'); a.className='arrow'; a.style.borderTopColor=p.color||'#5096FF';
    const lab=document.createElement('div'); lab.className='label'; lab.textContent=p.name||'Guest'; el.appendChild(a); el.appendChild(lab); cursors.appendChild(el);
  }
  el.style.left=p.x+'px'; el.style.top=p.y+'px';
}
function onPointerMove(e){ const p=stagePos(e); renderLocalCursor(p.x,p.y); send('cursor',{x:p.x,y:p.y,color:COLORS[state.colorIdx],name:state.name}); }
['pointermove'].forEach(t=>{ bitmap.addEventListener(t, onPointerMove); svg.addEventListener(t, onPointerMove); overlay.addEventListener(t, onPointerMove); });

// -------- Text (rich) --------
const textBar=$('#textBar'), textColor=$('#textColor');
function positionTextBar(target){ const r=target.getBoundingClientRect(); textBar.style.left=(r.left+r.width/2)+'px'; textBar.hidden=false; }
function hideTextBar(){ textBar.hidden=true; }
textBar.addEventListener('mousedown', e=> e.preventDefault());
textBar.addEventListener('click', (e)=>{ const b=e.target.closest('button'); if(!b) return;
  const cmd=b.dataset.cmd; if(cmd==='bold') document.execCommand('bold'); if(cmd==='italic') document.execCommand('italic'); if(cmd==='h1') heading(1); if(cmd==='h2') heading(2);
});
textColor.addEventListener('input', (e)=> document.execCommand('foreColor', false, e.target.value));
function heading(level){ const sel=window.getSelection(); if(!sel.rangeCount) return; const range=sel.getRangeAt(0); const el=document.createElement('div'); el.style.fontSize=level===1?'28px':'22px'; el.style.fontWeight='800'; el.style.lineHeight='1.2'; el.appendChild(range.extractContents()); range.insertNode(el); }
function serializeText(div){ return {id:div.dataset.id, x:parseFloat(div.style.left)||0, y:parseFloat(div.style.top)||0, html:div.innerHTML, w:div.style.width||'', h:div.style.height||'', color:div.style.color||'#172033'}; }
function addTextboxFromSerialized(s){ addTextbox(s, true); }
function addTextbox(p={}, fromRemote=false){
  const id=p.id||('t_'+Math.random().toString(36).slice(2));
  const div=document.createElement('div'); div.className='item textbox'; div.contentEditable='true';
  div.style.left=(p.x||120)+'px'; div.style.top=(p.y||120)+'px'; div.style.color=p.color||state.color; div.dataset.id=id; div.innerHTML=p.html||'Type…';
  overlay.appendChild(div);
  // stable drag (no jitter)
  let dragging=false, start=null, sx=0, sy=0;
  div.addEventListener('pointerdown', e=>{ if(state.tool!=='select') return; e.stopPropagation(); if(!e.shiftKey) clearSelection(); div.classList.add('selected'); state.selection.add(div); dragging=true; start=stagePos(e); sx=parseFloat(div.style.left)||0; sy=parseFloat(div.style.top)||0; div.setPointerCapture(e.pointerId); });
  div.addEventListener('pointermove', e=>{ if(!dragging) return; const p=stagePos(e); div.style.left=(sx+p.x-start.x)+'px'; div.style.top=(sy+p.y-start.y)+'px'; send('update',{kind:'text', data:serializeText(div)}); });
  div.addEventListener('pointerup', ()=>{ dragging=false; persist(); broadcastScene(); });
  // text bar
  div.addEventListener('focus', ()=> positionTextBar(div));
  div.addEventListener('blur', ()=> hideTextBar());
  div.addEventListener('input', ()=>{ send('update',{kind:'text', data:serializeText(div)}); persist(); });
  // resize
  const h=document.createElement('div'); h.className='handle'; div.appendChild(h);
  let resizing=false, rsx=0, rsy=0, rw=0, rh=0;
  h.addEventListener('pointerdown', e=>{ e.stopPropagation(); resizing=true; rsx=e.clientX; rsy=e.clientY; rw=div.offsetWidth; rh=div.offsetHeight; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e=>{ if(!resizing) return; div.style.width=(rw+(e.clientX-rsx))+'px'; div.style.height=(rh+(e.clientY-rsy))+'px'; send('update',{kind:'text', data:serializeText(div)}); });
  h.addEventListener('pointerup', ()=>{ resizing=false; persist(); broadcastScene(); });
  if(!fromRemote){ send('add',{kind:'text', data:serializeText(div)}); persist(); }
  if(!fromRemote && state.tool==='text'){ setToolSelect(); }
}
function setToolSelect(){ state.tool='select'; $$('.tool').forEach(b=>b.setAttribute('aria-pressed', b.dataset.tool==='select')); }

// -------- Tables (insert row/col) --------
function serializeTable(wrap){
  const x=parseFloat(wrap.style.left)||0, y=parseFloat(wrap.style.top)||0;
  const t=wrap.querySelector('table'), rows=t.rows.length, cols=t.rows[0].cells.length;
  const data=[...t.rows].map(tr=>[...tr.cells].map(td=>td.textContent));
  return {id:wrap.dataset.id, x,y, rows, cols, data};
}
function addTableFromSerialized(s){ addTable(s, true); }
function addTable(p={}, fromRemote=false){
  const id=p.id||('tbl_'+Math.random().toString(36).slice(2));
  const wrap=document.createElement('div'); wrap.className='item table'; wrap.dataset.id=id;
  wrap.style.left=(p.x||140)+'px'; wrap.style.top=(p.y||140)+'px';
  const table=document.createElement('table'); const rows=p.rows||3, cols=p.cols||3;
  for(let r=0;r<rows;r++){ const tr=document.createElement('tr'); for(let c=0;c<cols;c++){ const td=document.createElement('td'); td.contentEditable='true'; td.textContent=p.data?.[r]?.[c]||''; tr.appendChild(td);} table.appendChild(tr);}
  wrap.appendChild(table); overlay.appendChild(wrap);
  // drag
  let dragging=false, start=null, sx=0, sy=0;
  wrap.addEventListener('pointerdown', e=>{ if(state.tool!=='select') return; e.stopPropagation(); if(!e.shiftKey) clearSelection(); wrap.classList.add('selected'); state.selection.add(wrap); dragging=true; start=stagePos(e); sx=parseFloat(wrap.style.left)||0; sy=parseFloat(wrap.style.top)||0; wrap.setPointerCapture(e.pointerId); });
  wrap.addEventListener('pointermove', e=>{ if(!dragging) return; const p=stagePos(e); wrap.style.left=(sx+p.x-start.x)+'px'; wrap.style.top=(sy+p.y-start.y)+'px'; send('update',{kind:'table', data:serializeTable(wrap)}); });
  wrap.addEventListener('pointerup', ()=>{ dragging=false; persist(); broadcastScene(); });
  wrap.addEventListener('input', ()=>{ send('update',{kind:'table', data:serializeTable(wrap)}); persist(); });
  // context menu: insert row/col
  wrap.addEventListener('contextmenu', (e)=>{ e.preventDefault(); const m=document.createElement('div'); m.className='ctxmenu'; m.style.left=e.clientX+'px'; m.style.top=e.clientY+'px';
    const br=document.createElement('button'); br.textContent='Insert Row'; br.onclick=()=>{ const tr=document.createElement('tr'); for(let c=0;c<table.rows[0].cells.length;c++){ const td=document.createElement('td'); td.contentEditable='true'; tr.appendChild(td);} table.appendChild(tr); send('update',{kind:'table', data:serializeTable(wrap)}); persist(); document.body.removeChild(m); };
    const bc=document.createElement('button'); bc.textContent='Insert Column'; bc.onclick=()=>{ for(let r=0;r<table.rows.length;r++){ const td=document.createElement('td'); td.contentEditable='true'; table.rows[r].appendChild(td);} send('update',{kind:'table', data:serializeTable(wrap)}); persist(); document.body.removeChild(m); };
    m.appendChild(br); m.appendChild(bc); document.body.appendChild(m);
    const kill=()=>{ document.body.contains(m) && document.body.removeChild(m); window.removeEventListener('click', kill); }; window.addEventListener('click', kill);
  });
  if(!fromRemote){ send('add',{kind:'table', data:serializeTable(wrap)}); persist(); }
}

// -------- Import / Export --------
$('#imageImport').addEventListener('change', (e)=>{ const f=e.target.files[0]; if(!f) return; const r=new FileReader(); r.onload=()=>{ const img=new Image(); img.onload=()=>{ bctx.drawImage(img,60,60,img.width,img.height); persist(); broadcastScene(); }; img.src=r.result; }; r.readAsDataURL(f); });
$('#csvImport').addEventListener('change', async (e)=>{ const f=e.target.files[0]; if(!f) return; const text=await f.text(); const rows=text.trim().split(/\r?\n/).map(l=>l.split(',')); addTable({rows:rows.length, cols:rows[0]?.length||1, x:180, y:180, data:rows}); });
$('#exportBtn').addEventListener('click', async ()=>{
  const off=document.createElement('canvas'); off.width=bitmap.width; off.height=bitmap.height; const ctx=off.getContext('2d');
  ctx.drawImage(bitmap,0,0);
  const svgData=new XMLSerializer().serializeToString(svg.cloneNode(true));
  const svgBlob=new Blob([svgData],{type:'image/svg+xml;charset=utf-8'}); const url=URL.createObjectURL(svgBlob);
  const img=new Image(); await new Promise(res=>{ img.onload=()=>res(); img.src=url; }); ctx.drawImage(img,0,0); URL.revokeObjectURL(url);
  $$('.textbox', overlay).forEach(el=>{ const x=parseFloat(el.style.left)||0, y=parseFloat(el.style.top)||0, w=el.offsetWidth;
    ctx.save(); ctx.fillStyle='#fff'; ctx.fillRect(x,y,w,el.offsetHeight); ctx.strokeStyle='#E6E9EF'; ctx.strokeRect(x,y,w,el.offsetHeight);
    ctx.fillStyle=el.style.color||'#172033'; ctx.font='16px Inter'; ctx.textBaseline='top'; ctx.fillText(el.innerText, x+10, y+8); ctx.restore();
  });
  $$('.table', overlay).forEach(el=>{ const x=parseFloat(el.style.left)||0, y=parseFloat(el.style.top)||0; const t=el.querySelector('table'); const R=t.rows.length, C=t.rows[0].cells.length; const cw=96, ch=36; ctx.strokeStyle='#E6E9EF'; ctx.fillStyle='#fff'; ctx.fillRect(x,y,C*cw,R*ch);
    for(let r=0;r<R;r++){ for(let c=0;c<C;c++){ ctx.strokeRect(x+c*cw,y+r*ch,cw,ch); ctx.fillStyle='#172033'; ctx.font='14px Inter'; ctx.fillText(t.rows[r].cells[c].textContent, x+c*cw+8, y+r*ch+10); } }
  });
  const dataURL=off.toDataURL('image/png'); const a=document.createElement('a'); a.href=dataURL; a.download=`thingie-canvas-${state.room||'export'}.png`; a.click();
});

// -------- Remote ops --------
function addRemote(p){
  if(p.kind==='vector'){ const el=new DOMParser().parseFromString(p.html,'image/svg+xml').documentElement; svg.appendChild(el); attachVectorHandlers(el); }
  if(p.kind==='text'){ addTextbox(p.data, true); }
  if(p.kind==='table'){ addTable(p.data, true); }
  persist();
}
function updateRemote(p){
  if(p.id && p.html){ const el=svg.querySelector(`[data-id="${p.id}"]`); if(!el) return; const repl=new DOMParser().parseFromString(p.html,'image/svg+xml').documentElement; el.replaceWith(repl); attachVectorHandlers(repl); }
  else if(p.kind==='text'){ const d=p.data; const el=overlay.querySelector(`.textbox[data-id="${d.id}"]`); if(!el) return; el.style.left=d.x+'px'; el.style.top=d.y+'px'; el.style.color=d.color; el.style.width=d.w; el.style.height=d.h; el.innerHTML=d.html; }
  else if(p.kind==='table'){ const d=p.data; const el=overlay.querySelector(`.table[data-id="${d.id}"]`); if(!el) return; el.style.left=d.x+'px'; el.style.top=d.y+'px'; const t=el.querySelector('table');
    // normalize size
    while(t.rows.length<d.rows){ const tr=document.createElement('tr'); for(let c=0;c<d.cols;c++){ const td=document.createElement('td'); td.contentEditable='true'; tr.appendChild(td);} t.appendChild(tr); }
    for(let r=0;r<t.rows.length;r++){ while(t.rows[r].cells.length<d.cols){ const td=document.createElement('td'); td.contentEditable='true'; t.rows[r].appendChild(td);} }
    for(let r=0;r<d.rows;r++){ for(let c=0;c<d.cols;c++){ t.rows[r].cells[c].textContent=d.data?.[r]?.[c]||''; } }
  }
  persist();
}
function deleteRemote(id){
  svg.querySelector(`[data-id="${id}"]`)?.remove();
  overlay.querySelector(`[data-id="${id}"]`)?.remove();
  persist();
}

// -------- Add via toolbar (Text/Table convenience) --------
$$('.tool').find(b=>b.dataset.tool==='text')?.addEventListener('click', ()=> addTextbox({x:220,y:160,color:state.color}));
$$('.tool').find(b=>b.dataset.tool==='table')?.addEventListener('click', ()=> addTable({rows:3, cols:3, x:260, y:220}));

// -------- Local cursor broadcast --------
function onAnyPointerMove(e){ const p=stagePos(e); renderLocalCursor(p.x,p.y); send('cursor',{x:p.x,y:p.y,color:COLORS[state.colorIdx],name:state.name}); }
['pointermove'].forEach(t=>{ bitmap.addEventListener(t, onAnyPointerMove); svg.addEventListener(t, onAnyPointerMove); overlay.addEventListener(t, onAnyPointerMove); });

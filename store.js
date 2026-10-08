/* ============================================================
   PASTE YOUR WEB APP ADDRESS HERE (from Apps Script: Deploy > New deployment).
   It must start with https://script.google.com/macros/s/ and end with /exec
   ============================================================ */
const WEB_APP_URL = 'PASTE-YOUR-WEB-APP-URL-HERE';

/* MMRC Fleet Log — shared storage.
   Both logs save through the Google Apps Script web app:
   records go to a Google Sheet, receipt pictures to Google Drive.
   The web app address and login are kept on each device after signing in. */
(function(){
  const K_URL = 'mmrc-fleet-url', K_USER = 'mmrc-fleet-user', K_PASS = 'mmrc-fleet-pass';
  const DEFAULT_URL = WEB_APP_URL;
  const LISTS = ['jobs','vendors','trolleys'];
  const JSON_KEYS = new Set(['trolleyIds','receipt.file','receipt.files']);
  const NUM_KEYS  = new Set(['receipt.net','receipt.gst','receipt.total','receipt.pct']);

  const ls = {
    get(k){ try{ return localStorage.getItem(k) || ''; }catch(e){ return ''; } },
    set(k,v){ try{ v ? localStorage.setItem(k,v) : localStorage.removeItem(k); }catch(e){} }
  };

  const MSG = {
    setup:    'Please log in first.',
    network:  'Could not reach Google. Check the internet connection and try again.',
    passcode: 'The username or password is wrong.',
    signin:   'The web app asked for a Google sign-in. In Apps Script set "Who has access" to Anyone and deploy a new version.',
    reply:    'Google sent back something unexpected.',
    conflict: 'Someone else saved changes at the same time.'
  };
  function fail(code,msg,extra){ const e=new Error(msg); e.code=code; if(extra) e.extra=extra; return e; }

  async function call(action, body, cfg){
    const url  = String((cfg && cfg.url) || Store.url()).trim();
    const user = (cfg && cfg.user!=null) ? cfg.user : Store.user();
    const pass = (cfg && cfg.pass!=null) ? cfg.pass : Store.pass();
    if(!url || !user || !pass) throw fail('setup', MSG.setup);
    let res, text;
    try{
      res = await fetch(url, { method:'POST',
        // text/plain keeps it a simple request, so Apps Script needs no preflight
        headers:{'Content-Type':'text/plain;charset=utf-8'},
        body: JSON.stringify(Object.assign({ action, user, pass }, body||{})) });
      text = await res.text();
    }catch(e){ throw fail('network', MSG.network); }
    let out = null; try{ out = JSON.parse(text); }catch(e){}
    if(!out){
      if(/accounts\.google|ServiceLogin|signin/i.test(text)) throw fail('signin', MSG.signin);
      throw fail('reply', MSG.reply+' (HTTP '+res.status+')');
    }
    if(!out.ok){
      if(out.error==='Wrong login') throw fail('passcode', MSG.passcode);
      if(out.error==='conflict')       throw fail('conflict', MSG.conflict, out);
      throw fail('script', 'Google reported: '+out.error);
    }
    return out;
  }

  /* ---- records <-> sheet rows: one level of nesting becomes "receipt.total" style columns ---- */
  function cell(v){
    if(v==null) return '';
    if(typeof v==='boolean') return v ? 'TRUE' : 'FALSE';
    if(typeof v==='object') return JSON.stringify(v);
    return String(v);
  }
  function flatten(o){
    const r = {};
    Object.keys(o||{}).forEach(k=>{
      const v = o[k];
      if(v && typeof v==='object' && !Array.isArray(v)) Object.keys(v).forEach(s=>{ r[k+'.'+s] = cell(v[s]); });
      else r[k] = cell(v);
    });
    return r;
  }
  function value(k,v){
    v = v==null ? '' : String(v);
    if(v==='TRUE') return true;
    if(v==='FALSE') return false;
    if(JSON_KEYS.has(k)){
      const empty = (k==='trolleyIds' || k==='receipt.files') ? [] : null;
      if(!v) return empty;
      try{ return JSON.parse(v); }catch(e){ return k==='trolleyIds' ? v.split(',').map(s=>s.trim()).filter(Boolean) : empty; }
    }
    if(NUM_KEYS.has(k)) return v==='' ? '' : (Number(v)||0);
    return v;
  }
  function unflatten(row){
    const o = {}, nested = {};
    Object.keys(row).forEach(k=>{
      const d = k.indexOf('.');
      if(d>0){
        const top = k.slice(0,d);
        const n = nested[top] = nested[top] || { fields:{}, any:false };
        if(String(row[k]==null?'':row[k])==='') return;   // column belongs to the other fleet or was empty
        n.fields[k.slice(d+1)] = value(k,row[k]);
        n.any = true;
      } else o[k] = value(k,row[k]);
    });
    Object.keys(nested).forEach(top=>{ o[top] = nested[top].any ? nested[top].fields : null; });
    return o;
  }

  function open(fleet){
    let rev = 0, last = null, inflight = null, queued = null;

    async function load(){
      const out = await call('load', { fleet });
      rev = out.rev || 0;
      if(out.empty) return null;
      const st = Object.assign({}, out.settings || {});
      LISTS.forEach(k=>{ st[k] = (out.lists[k]||[]).map(unflatten); });
      last = JSON.stringify(st);
      return st;
    }
    async function send(s){
      const lists = {}, settings = {};
      LISTS.forEach(k=>{ lists[k] = (s[k]||[]).map(flatten); });
      Object.keys(s).forEach(k=>{ if(LISTS.indexOf(k)<0) settings[k] = s[k]; });
      const out = await call('save', { fleet, baseRev:rev, lists, settings });
      rev = out.rev;
    }
    async function pump(){
      try{
        while(queued!==null){
          const snap = queued; queued = null;
          if(snap===last) continue;
          try{ await send(JSON.parse(snap)); last = snap; }
          catch(e){ if(queued===null) queued = snap; throw e; }
        }
      } finally { inflight = null; }
    }
    function save(s){
      queued = JSON.stringify(s);
      if(!inflight) inflight = pump();
      return inflight;
    }
    async function overwrite(s){      // used by the one-time import
      const o = await call('load', { fleet });
      rev = o.rev || 0;
      await send(s);
      last = JSON.stringify(s);
    }
    return {
      fleet, load, save, overwrite,
      busy: ()=> !!inflight || queued!==null,
      getPhotos:  async jobId => (await call('getPhotos', { fleet, jobId })).photos || [],
      putPhotos:  async (jobId,list) => (await call('putPhotos', { fleet, jobId,
        photos:(list||[]).map(p=> p.id ? { id:p.id } : { name:p.name, type:p.type, data:p.data }) })).photos || [],
      dropPhotos: async jobId => { await call('dropPhotos', { fleet, jobId }); }
    };
  }

  const Store = {
    DEFAULT_URL, MSG, open, call,
    url:  ()=> ls.get(K_URL) || DEFAULT_URL,
    user: ()=> ls.get(K_USER),
    pass: ()=> ls.get(K_PASS),
    ready:()=> !!(Store.url() && Store.user() && Store.pass()),
    configure(url,user,pass){ ls.set(K_URL, String(url||'').trim()); ls.set(K_USER, String(user||'').trim()); ls.set(K_PASS, String(pass||'')); },
    forget(){ ls.set(K_PASS,''); },
    logout(){ ls.set(K_PASS,''); },
    ping: cfg => call('ping', {}, cfg)
  };
  window.Store = Store;

  // Lets phones install the site as an app (needs https, which GitHub Pages provides)
  if('serviceWorker' in navigator && location.protocol==='https:'){
    window.addEventListener('load', ()=>{ navigator.serviceWorker.register('sw.js').catch(()=>{}); });
  }
})();

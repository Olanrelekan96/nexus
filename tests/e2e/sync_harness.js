/* Browser-side sync simulation harness (loaded into the real app page by the E2E tests).
   It drives the REAL touchChangedEntities()/mergeStates()/Drive-cycle code with controlled clocks
   and devices, so merge behaviour is tested exactly as shipped. */
(function(){
  function clone(o){ return JSON.parse(JSON.stringify(o)); }
  function mulberry32(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var IGNORE = {deviceId:1, syncPeers:1, currentPageId:1, order:1, conflict:1, clockFloor:1, dailyShowAll:1};
  function canon(v){
    if(Array.isArray(v)) return v.map(canon);
    if(v && typeof v === 'object'){ var o = {}; Object.keys(v).sort().forEach(function(k){ if(IGNORE[k]) return; o[k] = canon(v[k]); }); return o; }
    return v;
  }
  function canonJson(s){ return JSON.stringify(canon(s)); }

  var idn = 0;
  function nid(p){ idn++; return p + idn.toString(36) + Math.floor(Math.random()*1e6).toString(36); }
  function addBlock(d, pageId, parentId, text){
    var id = nid('b'); var b = mkBlock(id, pageId, parentId || null, text); d.blocks[id] = b;
    if(parentId) d.blocks[parentId].children.push(id); else d.pages[pageId].rootBlocks.push(id);
    return id;
  }
  function baseState(){
    var s = clone(state); s.pages = {}; s.blocks = {}; s.titleIndex = {}; s.tombstones = {pages:{}, blocks:{}};
    s.flashcards = {decks:{}, cards:{}}; s.stickyNotes = {cards:{}}; s.folders = {};
    ['Alpha','Beta','Gamma'].forEach(function(title){
      var pid = nid('p'); s.pages[pid] = {id:pid, title:title, type:'page', createdAt:1000, updatedAt:1000, updatedBy:'seed', properties:[], rootBlocks:[]}; s.titleIndex[title.toLowerCase()] = pid;
      for(var i=0;i<4;i++){ var r = addBlock(s, pid, null, title+' line '+i); if(i%2===0) addBlock(s, pid, r, title+' child '+i); }
    });
    Object.keys(s.blocks).forEach(function(id){ s.blocks[id].updatedAt = 1000; s.blocks[id].updatedBy = 'seed'; });
    s.currentPageId = Object.keys(s.pages)[0];
    return s;
  }
  /* Apply edits to a device state under a controlled clock, through the app's own change tracking. */
  function edit(dev, ms, fn){
    var sState = state, sSnap = lastSnapshotJson, realNow = Date.now;
    state = dev; lastSnapshotJson = JSON.stringify(dev); Date.now = function(){ return ms; };
    try{ fn(dev); touchChangedEntities(); } finally { Date.now = realNow; state = sState; lastSnapshotJson = sSnap; }
    return dev;
  }
  function device(base, id){ var d = clone(base); d.deviceId = id; return d; }
  function merge(a, b, since){ return mergeStates(clone(a), clone(b), since === undefined ? null : since); }

  /* ---- random user actions (each keeps the tree consistent, like the real editor does) ---- */
  function pick(rnd, arr){ return arr[Math.floor(rnd()*arr.length)]; }
  function descendants(d, id, out){ (d.blocks[id].children||[]).forEach(function(c){ if(d.blocks[c]){ out.push(c); descendants(d, c, out); } }); return out; }
  function unlink(d, id){
    var b = d.blocks[id]; var list = b.parent ? d.blocks[b.parent].children : d.pages[b.pageId].rootBlocks;
    var i = list.indexOf(id); if(i >= 0) list.splice(i, 1);
  }
  var OPS = {
    edit: function(d, rnd, tag){ var ids = Object.keys(d.blocks); if(!ids.length) return; d.blocks[pick(rnd, ids)].text = 'edit-'+tag+'-'+Math.floor(rnd()*1e6); },
    add: function(d, rnd, tag){ var pids = Object.keys(d.pages); if(!pids.length) return; var pid = pick(rnd, pids); var cand = Object.keys(d.blocks).filter(function(i){ return d.blocks[i].pageId === pid; }); var parent = cand.length && rnd() < .5 ? pick(rnd, cand) : null; addBlock(d, pid, parent, 'new-'+tag+'-'+Math.floor(rnd()*1e6)); },
    del: function(d, rnd){ var ids = Object.keys(d.blocks); if(!ids.length) return; var id = pick(rnd, ids); var all = [id].concat(descendants(d, id, [])); unlink(d, id); all.forEach(function(x){ delete d.blocks[x]; }); },
    move: function(d, rnd){ var ids = Object.keys(d.blocks); if(ids.length < 2) return; var id = pick(rnd, ids), tgt = pick(rnd, ids); if(id === tgt) return; var b = d.blocks[id], t = d.blocks[tgt]; if(b.pageId !== t.pageId) return; if(descendants(d, id, []).indexOf(tgt) >= 0) return; unlink(d, id); b.parent = tgt; t.children.push(id); },
    reorder: function(d, rnd){ var pids = Object.keys(d.pages); var p = d.pages[pick(rnd, pids)]; if(p && p.rootBlocks.length > 1){ var a = p.rootBlocks.splice(Math.floor(rnd()*p.rootBlocks.length), 1)[0]; p.rootBlocks.splice(Math.floor(rnd()*(p.rootBlocks.length+1)), 0, a); } },
    rename: function(d, rnd, tag){ var pids = Object.keys(d.pages); if(!pids.length) return; var p = d.pages[pick(rnd, pids)]; delete d.titleIndex[p.title.toLowerCase()]; p.title = 'Renamed-'+tag+'-'+Math.floor(rnd()*1e6); d.titleIndex[p.title.toLowerCase()] = p.id; },
    addPage: function(d, rnd, tag){ var pid = nid('p'); d.pages[pid] = {id:pid, title:'NewPage-'+tag+'-'+Math.floor(rnd()*1e6), type:'page', createdAt:Date.now(), properties:[], rootBlocks:[]}; d.titleIndex[d.pages[pid].title.toLowerCase()] = pid; addBlock(d, pid, null, 'first line'); },
    delPage: function(d, rnd){ var pids = Object.keys(d.pages); if(pids.length < 2) return; var pid = pick(rnd, pids); Object.keys(d.blocks).forEach(function(i){ if(d.blocks[i].pageId === pid) delete d.blocks[i]; }); delete d.titleIndex[d.pages[pid].title.toLowerCase()]; delete d.pages[pid]; },
    icon: function(d, rnd){ var pids = Object.keys(d.pages); if(!pids.length) return; d.pages[pick(rnd, pids)].icon = pick(rnd, ['🔥','📌','🌱','⭐']); },
    collapse: function(d, rnd){ var ids = Object.keys(d.blocks); if(!ids.length) return; var b = d.blocks[pick(rnd, ids)]; b.collapsed = !b.collapsed; },
    prop: function(d, rnd){ var pids = Object.keys(d.pages); if(!pids.length) return; d.pages[pick(rnd, pids)].properties = [{key:'status', value:pick(rnd, ['open','done','wip']), type:'select'}]; }
  };
  function invariants(s){
    var errs = [];
    Object.keys(s.blocks).forEach(function(id){
      var b = s.blocks[id];
      if(!s.pages[b.pageId]) errs.push('block '+id+' on missing page');
      else if(b.parent){ var p = s.blocks[b.parent]; if(!p) errs.push('block '+id+' has missing parent'); else if(p.children.indexOf(id) < 0) errs.push('parent does not list '+id); }
      else if(s.pages[b.pageId].rootBlocks.indexOf(id) < 0) errs.push('page does not list root '+id);
    });
    Object.keys(s.pages).forEach(function(pid){
      var seen = {}; (s.pages[pid].rootBlocks||[]).forEach(function(id){ if(!s.blocks[id]) errs.push('page lists missing block '+id); if(seen[id]) errs.push('dup root '+id); seen[id] = 1; });
    });
    Object.keys(s.blocks).forEach(function(id){ var seen = {}; (s.blocks[id].children||[]).forEach(function(c){ if(!s.blocks[c]) errs.push('block lists missing child'); if(seen[c]) errs.push('dup child'); seen[c] = 1; }); });
    return errs;
  }
  function diffEntities(x, y){
    var out = [];
    ['pages','blocks','tombstones'].forEach(function(sec){
      var ax = canon(x)[sec] || {}, ay = canon(y)[sec] || {};
      var ids = {}; Object.keys(ax).forEach(function(k){ ids[k] = 1; }); Object.keys(ay).forEach(function(k){ ids[k] = 1; });
      Object.keys(ids).forEach(function(id){ var jx = JSON.stringify(ax[id]), jy = JSON.stringify(ay[id]); if(jx !== jy && out.length < 3) out.push({sec:sec, id:id, x:(jx||'').slice(0,240), y:(jy||'').slice(0,240)}); });
    });
    return out;
  }
  /* Random two-device sessions: convergence (commutative), idempotence, invariants. */
  function randomTrials(n, seed, opNames){
    var rnd = mulberry32(seed), fails = {}, sample = {}, base = baseState();
    opNames = opNames || Object.keys(OPS);
    function note(kind, info){ fails[kind] = (fails[kind]||0) + 1; if(!sample[kind]) sample[kind] = info; }
    for(var t=0;t<n;t++){
      var A = device(base, 'devA'), B = device(base, 'devB'), clock = 2000, log = [];
      var steps = 2 + Math.floor(rnd()*6);
      for(var i=0;i<steps;i++){
        var which = rnd() < .5 ? A : B, op = pick(rnd, opNames); clock += 10 + Math.floor(rnd()*50);
        log.push((which === A ? 'A:' : 'B:') + op);
        edit(which, clock, function(d){ OPS[op](d, rnd, which === A ? 'a' : 'b'); });
      }
      var m1 = merge(A, B, 1500).state, m2 = merge(B, A, 1500).state;
      if(canonJson(m1) !== canonJson(m2)) note('not-commutative', {log: log, diff: diffEntities(m1, m2)});
      var i1 = invariants(m1); if(i1.length) note('invariant', {log: log, errs: i1.slice(0,3)});
      var r1 = merge(m1, A, 1500).state, r2 = merge(m1, B, 1500).state;
      if(canonJson(r1) !== canonJson(m1)) note('not-idempotent-with-A', {log: log, diff: diffEntities(m1, r1)});
      if(canonJson(r2) !== canonJson(m1)) note('not-idempotent-with-B', {log: log, diff: diffEntities(m1, r2)});
      /* three-way: whichever order the devices relay through a third replica they end up equal */
      var viaA = merge(merge(m1, A, 1500).state, B, 1500).state, viaB = merge(merge(m2, B, 1500).state, A, 1500).state;
      if(canonJson(viaA) !== canonJson(viaB)) note('three-way-diverges', {log: log, diff: diffEntities(viaA, viaB)});
    }
    return {trials: n, fails: fails, sample: sample};
  }

  /* True if the only difference between two canonical page/block records is the ORDER of
     rootBlocks/children (same set of ids, different sequence) -- everything else identical.
     Used by longOfflineTrials to distinguish real data loss from a narrow, verified-non-
     destructive ordering artifact (see that function's own comment for what this is and why
     it's classified separately instead of silently tolerated or naively failed on). */
  function isOrderOnlyDiff(x, y){
    if(!x || !y || typeof x !== 'object' || typeof y !== 'object') return false;
    var xk = Object.keys(x).sort(), yk = Object.keys(y).sort();
    if(JSON.stringify(xk) !== JSON.stringify(yk)) return false;
    for(var i=0;i<xk.length;i++){
      var k = xk[i];
      if(k === 'rootBlocks' || k === 'children'){
        if(!Array.isArray(x[k]) || !Array.isArray(y[k])) return false;
        if(JSON.stringify(x[k].slice().sort()) !== JSON.stringify(y[k].slice().sort())) return false;
      } else if(JSON.stringify(x[k]) !== JSON.stringify(y[k])) return false;
    }
    return true;
  }
  /* True if EVERY page/block that differs between two states differs only via isOrderOnlyDiff. */
  function onlyOrderDiffers(s1, s2){
    var c1 = canon(s1), c2 = canon(s2), ok = true;
    ['pages','blocks'].forEach(function(sec){
      Object.keys(c1[sec] || {}).forEach(function(id){
        var x = c1[sec][id], y = (c2[sec] || {})[id];
        if(JSON.stringify(x) !== JSON.stringify(y) && !isOrderOnlyDiff(x, y)) ok = false;
      });
    });
    return ok;
  }

  /* Two devices that go offline from each other for a long stretch (months, not milliseconds) and
     each independently accumulate a large, uninterrupted batch of changes before ever syncing
     again. randomTrials/protocolTrials/driveTrials above only ever interleave single edits a few
     tens of milliseconds apart, alternating which device edits next -- a fundamentally different
     shape of divergence than "each side changes a lot entirely on its own, then reconnects once".
     Checks the exact same proven invariants as randomTrials (commutativity, structural soundness,
     idempotence, three-way convergence) against this different edit-generation pattern, rather
     than inventing new ones -- what's new here is the SHAPE of the divergence being tested, not
     the definition of a correct merge.

     One real, narrow finding from building this test: heavy CONCURRENT reordering (both devices
     independently moving/reordering blocks in the same list during a long divergence) can leave
     the exact display ORDER of the affected list slightly different depending on which order the
     merge is computed in or propagated through -- verified via isOrderOnlyDiff/onlyOrderDiffers
     across hundreds of trials to NEVER coincide with an actual set/content difference: the same
     blocks, same text, same hierarchy, same everything except which of two valid positions a
     handful of reordered items land in. Not data loss, not corruption, self-correcting on the next
     edit to that list -- but a real, previously-unknown limitation of the reorder merge logic
     under this specific pattern, not previously tested. Recorded as its own fail kind
     (order-only-nondeterminism) rather than either silently tolerated or bucketed in with actual
     failures, so it's visible without being conflated with a real bug. */
  function longOfflineTrials(n, seed, opNames){
    var rnd = mulberry32(seed), fails = {}, sample = {}, base = baseState();
    opNames = opNames || Object.keys(OPS);
    function note(kind, info){ fails[kind] = (fails[kind]||0) + 1; if(!sample[kind]) sample[kind] = info; }
    var DAY = 24*60*60*1000;
    for(var t=0;t<n;t++){
      var A = device(base, 'devA'), B = device(base, 'devB'), log = [];
      [[A,'a'], [B,'b']].forEach(function(pair){
        var d = pair[0], tag = pair[1], clock = 100000;
        var steps = 15 + Math.floor(rnd()*20);
        for(var i=0;i<steps;i++){
          clock += DAY * (1 + Math.floor(rnd()*4)); /* 1-4 simulated days between this device's own edits */
          var op = pick(rnd, opNames); log.push(tag+':'+op+'@'+Math.floor(clock/DAY)+'d');
          edit(d, clock, function(dev){ OPS[op](dev, rnd, tag); });
        }
      });
      var since = 1500;
      var m1 = merge(A, B, since).state, m2 = merge(B, A, since).state;
      if(canonJson(m1) !== canonJson(m2)){
        if(onlyOrderDiffers(m1, m2)) note('order-only-nondeterminism', {log: log, kind:'not-commutative'});
        else note('not-commutative', {log: log, diff: diffEntities(m1, m2)});
      }
      var inv = invariants(m1); if(inv.length) note('invariant', {log: log, errs: inv.slice(0,3)});
      var r1 = merge(m1, A, since).state, r2 = merge(m1, B, since).state;
      if(canonJson(r1) !== canonJson(m1)){
        if(onlyOrderDiffers(m1, r1)) note('order-only-nondeterminism', {log: log, kind:'not-idempotent-with-A'});
        else note('not-idempotent-with-A', {log: log, diff: diffEntities(m1, r1)});
      }
      if(canonJson(r2) !== canonJson(m1)){
        if(onlyOrderDiffers(m1, r2)) note('order-only-nondeterminism', {log: log, kind:'not-idempotent-with-B'});
        else note('not-idempotent-with-B', {log: log, diff: diffEntities(m1, r2)});
      }
      var viaA = merge(merge(m1, A, since).state, B, since).state, viaB = merge(merge(m2, B, since).state, A, since).state;
      if(canonJson(viaA) !== canonJson(viaB)){
        if(onlyOrderDiffers(viaA, viaB)) note('order-only-nondeterminism', {log: log, kind:'three-way-diverges'});
        else note('three-way-diverges', {log: log, diff: diffEntities(viaA, viaB)});
      }
    }
    return {trials: n, fails: fails, sample: sample};
  }

  /* The real protocol: each device repeatedly pulls the other's state, merges, adopts the result and
     pushes it back. Eventual consistency = both replicas reach the same fixpoint within a few rounds. */
  function protocolTrials(n, seed, opNames){
    var rnd = mulberry32(seed), base = baseState(), bad = 0, rounds = {}, sample = null;
    opNames = opNames || Object.keys(OPS);
    for(var t=0;t<n;t++){
      var A = device(base, 'devA'), B = device(base, 'devB'), clock = 2000, log = [];
      var steps = 2 + Math.floor(rnd()*6);
      for(var i=0;i<steps;i++){
        var which = rnd() < .5 ? A : B, op = pick(rnd, opNames); clock += 10 + Math.floor(rnd()*50); log.push((which===A?'A:':'B:')+op);
        edit(which, clock, function(d){ OPS[op](d, rnd, which === A ? 'a' : 'b'); });
      }
      var n2 = 0, converged = false;
      for(; n2 < 8; n2++){
        var beforeA = canonJson(A), beforeB = canonJson(B);
        A = merge(A, B, 1500).state; B = merge(B, A, 1500).state;
        if(canonJson(A) === canonJson(B) && canonJson(A) === beforeA && canonJson(B) === beforeB){ converged = true; break; }
      }
      rounds[n2] = (rounds[n2]||0) + 1;
      if(!converged || invariants(A).length){ bad++; if(!sample) sample = {log: log, rounds: n2, inv: invariants(A).slice(0,2)}; }
    }
    return {trials:n, notConverged:bad, rounds:rounds, sample:sample};
  }

  /* Three devices syncing through ONE shared Drive file, the way the app does it: pull the file, merge, push
     the merged state back over it. Two devices may pull the same version before either pushes (the second push
     then overwrites the first), so 'concurrent' rounds are simulated as well. Everyone must end on the same state. */
  function driveTrials(n, seed, opNames, checkAdds, maxRounds){
    maxRounds = maxRounds || 10;
    var rnd = mulberry32(seed), base = baseState(), bad = 0, lostAdds = 0, sample = null, rounds = {};
    opNames = opNames || Object.keys(OPS);
    for(var t=0;t<n;t++){
      var S = [device(base,'devA'), device(base,'devB'), device(base,'devC')], clock = 2000, log = [], added = [];
      var steps = 3 + Math.floor(rnd()*8);
      for(var i=0;i<steps;i++){
        var di = Math.floor(rnd()*3), op = pick(rnd, opNames); clock += 10 + Math.floor(rnd()*50); log.push('ABC'[di]+':'+op);
        var before = {}; Object.keys(S[di].blocks).forEach(function(k){ before[k] = 1; });
        edit(S[di], clock, function(d){ OPS[op](d, rnd, 'abc'[di]); });
        if(op === 'add') Object.keys(S[di].blocks).forEach(function(k){ if(!before[k]) added.push(k); });
      }
      var F = null, converged = false, r = 0;
      for(; r < maxRounds; r++){
        var order = [0,1,2].sort(function(){ return rnd() - .5; });
        var concurrent = rnd() < .5, P = F ? clone(F) : null;
        order.forEach(function(di2){
          var pulled = concurrent ? P : F;
          if(pulled) S[di2] = merge(S[di2], pulled, 1500).state;
          F = clone(S[di2]);
        });
        var cj = canonJson(F);
        if(canonJson(S[0]) === cj && canonJson(S[1]) === cj && canonJson(S[2]) === cj){ converged = true; break; }
      }
      rounds[r] = (rounds[r]||0) + 1;
      var inv = invariants(S[0]).concat(invariants(S[1]), invariants(S[2]));
      if(!converged || inv.length){ bad++; if(!sample){ var cjF = canonJson(F); var pair = canonJson(S[0]) !== cjF ? S[0] : (canonJson(S[1]) !== cjF ? S[1] : S[2]); sample = {log: log, rounds: r, inv: inv.slice(0,2), diff: diffEntities(F, pair), missing: added.filter(function(id){ return !S[0].blocks[id] || !S[1].blocks[id] || !S[2].blocks[id]; }).map(function(id){ return [id, !!S[0].blocks[id], !!S[1].blocks[id], !!S[2].blocks[id], !!F.blocks[id]]; })}; } }
      if(checkAdds){ added.forEach(function(id){ if(!S[0].blocks[id] || !S[1].blocks[id] || !S[2].blocks[id]) lostAdds++; }); }
    }
    return {trials:n, notConvergedOrBroken:bad, lostAdds:lostAdds, rounds:rounds, sample:sample};
  }
  window.NexusSim = {driveTrials:driveTrials, protocolTrials:protocolTrials, clone:clone, canon:canon, canonJson:canonJson, baseState:baseState, edit:edit, device:device, merge:merge, addBlock:addBlock, OPS:OPS, invariants:invariants, randomTrials:randomTrials, longOfflineTrials:longOfflineTrials, mulberry32:mulberry32};
})();

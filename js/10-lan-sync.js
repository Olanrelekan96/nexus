/* ============================================================
 * 10-lan-sync.js
 * Direct LAN sync (no relay, no internet): shared utilities and protocol.
 *
 * Part of Nexus — loaded as a plain <script> (not a module) in
 * index.html, in numeric filename order. All files share one global
 * scope on purpose (same as the original single-file build), so
 * `state`, helper functions, etc. declared in an earlier file are
 * directly usable here without imports.
 * ============================================================ */
"use strict";

/* ============================================================
   SYNC — shared utilities used by LAN sync below.
   (The relay-based/MQTT sync transport that used to live here has
   been removed — LAN sync, further down, is now the only transport.)
   ============================================================ */
var DEVICE_NAME_KEY = "nexus_device_name";

function myDeviceName(){
  return localStorage.getItem(DEVICE_NAME_KEY) || "My device";
}

function timeAgo(ts){
  var s = Math.round((Date.now()-ts)/1000);
  if(s < 5) return 'just now';
  if(s < 60) return s + 's ago';
  var m = Math.round(s/60);
  if(m < 60) return m + 'm ago';
  return Math.round(m/60) + 'h ago';
}

/* Called from save() whenever the notebook changes, to push the
   update out over whatever sync transport is connected. LAN sync
   (below) is now the only transport. */
function broadcastStateToPeers(){
  broadcastStateToLanPeers();
}

function openSyncModal(){
  document.getElementById('sync-device-name').value = myDeviceName();
  document.getElementById('sync-overlay').style.display = 'flex';
  renderLanPeerList();
}
function closeSyncModal(){
  document.getElementById('sync-overlay').style.display = 'none';
}

document.getElementById('btn-sync').onclick = openSyncModal;
document.getElementById('sync-close').onclick = closeSyncModal;
document.getElementById('sync-close-x').onclick = closeSyncModal;
document.getElementById('sync-overlay').addEventListener('click', function(e){
  if(e.target.id === 'sync-overlay') closeSyncModal();
});
document.getElementById('sync-device-name').addEventListener('input', function(e){
  localStorage.setItem(DEVICE_NAME_KEY, e.target.value.trim() || "My device");
});

/* ============================================================
   LAN SYNC — DIRECT, NO RELAY, NO INTERNET
   A second, independent transport from Sync devices above. Two devices
   exchange a WebRTC offer/answer by hand (copy/paste — there is no
   signaling server of any kind), with iceServers deliberately left
   empty so ICE only ever gathers "host" candidates: this device's own
   local-network address. No STUN server is contacted to learn a public
   IP, no TURN relay is used as a fallback if a direct path fails, and
   the SDP exchange itself never touches a server either — the two
   codes below are just text the person moves between devices however
   they like. If the devices aren't reachable on the same local network,
   the connection simply won't complete; there is no fallback path, by
   design — that's what makes this genuinely relay-free, unlike Sync
   devices above which depends on a broker being reachable.

   Once the resulting RTCDataChannel is open, traffic is already
   encrypted in transit by WebRTC's mandatory DTLS, so — unlike the
   Sync-devices code above, which must encrypt before handing bytes to
   a broker it doesn't control — nothing further is layered on top here.

   The cost of having no server at all: there's nothing to hold a
   message for a device that isn't currently open, so pairing is a live
   handshake (both devices need this dialog open at the same time), and
   since a browser can't resume an RTCPeerConnection across a reload,
   it has to be redone each session you want to sync this way. Once
   connected, though, it stays open and syncs live like any other link.
   ============================================================ */
var lanLinks = []; /* runtime only, never persisted: {id, label, pc, dc, status, lastSync} */
var lanPendingOffer = null;  /* {pc, dc} while this device has shown a code and is waiting for the reply */

function lanIceConfig(){
  return { iceServers: [] }; /* deliberately empty — see header comment above */
}

/* Waits for ICE gathering to finish so the SDP we hand to the person
   already has every local candidate baked in ("vanilla ICE" — no
   trickle needed for a copy/paste flow where both sides are offline
   between steps anyway). */
function waitForIceGatheringComplete(pc){
  if(pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(function(resolve){
    function check(){
      if(pc.iceGatheringState === 'complete'){
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      }
    }
    pc.addEventListener('icegatheringstatechange', check);
    /* Backstop: a network with no usable candidates at all (Wi-Fi off,
       etc.) can leave gathering stuck — don't hang the UI forever. */
    setTimeout(resolve, 4000);
  });
}

function lanCodeEncode(desc){
  return btoa(unescape(encodeURIComponent(JSON.stringify({type: desc.type, sdp: desc.sdp}))));
}
function lanCodeDecode(code){
  return JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
}

function renderLanPeerList(){
  var wrap = document.getElementById('lan-peer-list');
  if(!wrap) return;
  wrap.innerHTML = "";
  lanLinks.forEach(function(link){
    var row = document.createElement('div');
    row.className = 'version-item';
    var left = document.createElement('div');
    var statusText = link.status === 'open'
      ? ('Synced ' + (link.lastSync ? timeAgo(link.lastSync) : 'just now') + ' · local network')
      : (link.status === 'connecting' ? 'Connecting…' : 'Disconnected');
    left.innerHTML = '<div>'+escapeHtml(link.label)+'</div><div class="v-meta">'+escapeHtml(statusText)+'</div>';
    var btn = document.createElement('button');
    btn.textContent = 'Disconnect';
    btn.onclick = function(){ closeLanLink(link); };
    row.appendChild(left); row.appendChild(btn);
    wrap.appendChild(row);
  });
}

function closeLanLink(link){
  try{ if(link.dc) link.dc.close(); }catch(e){}
  try{ if(link.pc) link.pc.close(); }catch(e){}
  var idx = lanLinks.indexOf(link);
  if(idx > -1) lanLinks.splice(idx,1);
  renderLanPeerList();
}

function wireLanDataChannel(link, dc){
  link.dc = dc;
  dc.onopen = function(){
    link.status = 'open';
    renderLanPeerList();
    publishStateToLan(link); /* push our current state right away, so the other side is caught up immediately */
  };
  dc.onclose = function(){
    link.status = 'closed';
    renderLanPeerList();
  };
  dc.onmessage = function(e){
    var msg;
    try{ msg = JSON.parse(e.data); }catch(err){ return; }
    handleIncomingLanSync(link, msg);
  };
}

function publishStateToLan(link){
  if(!link.dc || link.dc.readyState !== 'open') return;
  deriveOrder(state);
  var payload = JSON.parse(JSON.stringify(state));
  try{ link.dc.send(JSON.stringify({kind:'sync', fromName: myDeviceName(), fromId: state.deviceId, payload: payload})); }catch(e){}
}

/* Same merge logic as the relay-based sync above (mergeStates is the
   one, well-tested engine both transports share) — only the wire the
   bytes travel over differs. */
function handleIncomingLanSync(link, msg){
  if(!msg || msg.kind !== 'sync') return;
  if(msg.fromName){ link.label = msg.fromName; renderLanPeerList(); }
  if(msg.fromId && msg.fromId !== state.deviceId) link.peerId = msg.fromId;
  var sinceTs = link.lastSync || (link.peerId && state.syncPeers && state.syncPeers[link.peerId]) || null;
  var result = mergeStates(state, msg.payload, sinceTs);
  var merged = result.state;
  /* Compare entity/content state before adding the local sync cursor so a
     cursor-only exchange does not create an undo entry. */
  var changed = JSON.stringify(merged) !== JSON.stringify(state);
  var syncTs = Date.now();
  link.lastSync = syncTs;
  if(link.peerId){
    if(!merged.syncPeers || typeof merged.syncPeers !== 'object') merged.syncPeers = {};
    merged.syncPeers[link.peerId] = syncTs;
  }
  if(changed){
    applyIncomingMerge(merged);
    toast('Synced with ' + link.label + ' (LAN).');
  } else if(link.peerId){
    /* Persist the per-peer cursor even when there were no entity changes so
       a reload can still detect the next genuine concurrent edit. */
    state.syncPeers[link.peerId] = syncTs;
    save({touchEntities:false, recordUndo:false, broadcast:false});
  }
  if(result.conflicts.length){
    recordConflicts(result.conflicts, link.label);
    toast(result.conflicts.length + (result.conflicts.length === 1 ? ' line conflicted' : ' lines conflicted') +
      ' while syncing with ' + link.label + ' — see Sync conflicts.');
  }
  renderLanPeerList();
}

function broadcastStateToLanPeers(){
  lanLinks.forEach(function(link){ publishStateToLan(link); });
}

function showLanPanel(which){
  document.getElementById('lan-panel-offer').style.display = which === 'offer' ? '' : 'none';
  document.getElementById('lan-panel-answer').style.display = which === 'answer' ? '' : 'none';
  document.getElementById('lan-panel-choice').style.display = which ? 'none' : '';
  document.getElementById('lan-offer-code').value = "";
  document.getElementById('lan-offer-reply-input').value = "";
  document.getElementById('lan-offer-status').textContent = "";
  document.getElementById('lan-answer-input').value = "";
  document.getElementById('lan-answer-reply-code').value = "";
  document.getElementById('lan-answer-reply-wrap').style.display = 'none';
  document.getElementById('lan-answer-status').textContent = "";
  if(lanPendingOffer){ try{ lanPendingOffer.pc.close(); }catch(e){} lanPendingOffer = null; }
}

document.getElementById('lan-start-offer').onclick = function(){
  if(typeof RTCPeerConnection === 'undefined'){ toast('This browser does not support WebRTC.'); return; }
  showLanPanel('offer');
  var statusEl = document.getElementById('lan-offer-status');
  statusEl.textContent = 'Generating code…';
  var pc = new RTCPeerConnection(lanIceConfig());
  var dc = pc.createDataChannel('nexus-sync');
  lanPendingOffer = {pc: pc, dc: dc};
  pc.createOffer().then(function(offer){
    return pc.setLocalDescription(offer);
  }).then(function(){
    return waitForIceGatheringComplete(pc);
  }).then(function(){
    document.getElementById('lan-offer-code').value = lanCodeEncode(pc.localDescription);
    statusEl.textContent = 'Send this code to your other device, then paste its reply below.';
  }).catch(function(){
    statusEl.textContent = 'Could not generate a code on this device/browser.';
  });
};
document.getElementById('lan-offer-copy').onclick = function(){
  copyToClipboard(document.getElementById('lan-offer-code').value);
  toast('Code copied.');
};
document.getElementById('lan-offer-complete').onclick = function(){
  var statusEl = document.getElementById('lan-offer-status');
  if(!lanPendingOffer){ statusEl.textContent = 'Generate a code first.'; return; }
  var raw = document.getElementById('lan-offer-reply-input').value.trim();
  if(!raw){ statusEl.textContent = 'Paste the reply code first.'; return; }
  var answer;
  try{ answer = lanCodeDecode(raw); }catch(e){ statusEl.textContent = "That reply code doesn't look valid."; return; }
  var pending = lanPendingOffer;
  pending.pc.setRemoteDescription(answer).then(function(){
    var link = {id: uid(), label: 'New device', pc: pending.pc, dc: null, status: 'connecting', lastSync: null, peerId: null};
    lanLinks.push(link);
    wireLanDataChannel(link, pending.dc);
    lanPendingOffer = null;
    renderLanPeerList();
    showLanPanel(null);
    toast('Connecting on the local network…');
  }).catch(function(){
    statusEl.textContent = 'That reply code did not match — try generating a fresh one on each side.';
  });
};
document.getElementById('lan-offer-back').onclick = function(){ showLanPanel(null); };

document.getElementById('lan-start-answer').onclick = function(){
  if(typeof RTCPeerConnection === 'undefined'){ toast('This browser does not support WebRTC.'); return; }
  showLanPanel('answer');
};
document.getElementById('lan-answer-generate').onclick = function(){
  var statusEl = document.getElementById('lan-answer-status');
  var raw = document.getElementById('lan-answer-input').value.trim();
  if(!raw){ statusEl.textContent = 'Paste the code from the other device first.'; return; }
  var offer;
  try{ offer = lanCodeDecode(raw); }catch(e){ statusEl.textContent = "That code doesn't look valid."; return; }
  statusEl.textContent = 'Generating reply…';
  var pc = new RTCPeerConnection(lanIceConfig());
  var link = {id: uid(), label: 'New device', pc: pc, dc: null, status: 'connecting', lastSync: null, peerId: null};
  pc.ondatachannel = function(e){ wireLanDataChannel(link, e.channel); };
  pc.setRemoteDescription(offer).then(function(){
    return pc.createAnswer();
  }).then(function(ans){
    return pc.setLocalDescription(ans);
  }).then(function(){
    return waitForIceGatheringComplete(pc);
  }).then(function(){
    lanLinks.push(link);
    document.getElementById('lan-answer-reply-code').value = lanCodeEncode(pc.localDescription);
    document.getElementById('lan-answer-reply-wrap').style.display = '';
    statusEl.textContent = 'Send this reply code back to the other device to finish pairing.';
    renderLanPeerList();
  }).catch(function(){
    statusEl.textContent = 'Could not connect using that code.';
  });
};
document.getElementById('lan-answer-copy').onclick = function(){
  copyToClipboard(document.getElementById('lan-answer-reply-code').value);
  toast('Reply code copied.');
};
document.getElementById('lan-answer-back').onclick = function(){ showLanPanel(null); };

/* Best-effort teardown so a reload/close doesn't leave dangling
   connections — the other side's onclose fires and it just shows
   this device as disconnected, same as any ordinary network drop. */
window.addEventListener('beforeunload', function(){
  lanLinks.forEach(function(link){
    try{ if(link.pc) link.pc.close(); }catch(e){}
  });
});


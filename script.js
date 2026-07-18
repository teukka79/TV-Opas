let channels = [];      // {id, name, icon}
let programmesByCh = {}; // id -> [{start:Date, stop:Date, title, desc, category}]
let expandedId = null;

const $ = s => document.querySelector(s);
const fileInput = $('#fileInput');
const dropzone = $('#dropzone');
const statusEl = $('#status');
const clearBtn = $('#clearBtn');

// ---------- XMLTV parsing ----------
function parseXmltvTime(str){
  if(!str) return null;
  const m = str.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s?([+-]\d{2})(\d{2}))?$/);
  if(!m) return null;
  const [, y, mo, d, h, mi, s, offH, offM] = m;
  let utcMs = Date.UTC(+y, +mo-1, +d, +h, +mi, +s);
  if(offH !== undefined){
    const sign = offH[0] === '-' ? -1 : 1;
    const hh = Math.abs(parseInt(offH,10));
    const mm = parseInt(offM,10);
    utcMs -= sign*(hh*60+mm)*60000;
  }
  return new Date(utcMs);
}

function hashStr(s){
  let h = 5381;
  for(let i = 0; i < s.length; i++){ h = ((h << 5) + h) + s.charCodeAt(i); h = h & 0xffffffff; }
  return Math.abs(h).toString(36);
}

function parseXmltvData(xmlText, idPrefix){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const perr = doc.querySelector('parsererror');
  if(perr) throw new Error('XML ei kelpaa – tarkista tiedosto.');

  const chNodes = [...doc.getElementsByTagName('channel')];
  if(chNodes.length === 0) throw new Error('Tiedostosta ei löytynyt yhtään <channel>-elementtiä.');

  const channels = chNodes.map(c => {
    const dn = c.querySelector('display-name');
    const icon = c.querySelector('icon');
    const lcn = c.querySelector('lcn, number, channel-number');
    let xmlNumber = lcn ? lcn.textContent.trim() : '';
    if(!xmlNumber){
      // jotkut oppaat pistävät numeron toiseen display-name-elementtiin, esim "118"
      const names = [...c.querySelectorAll('display-name')].map(n => n.textContent.trim());
      const numeric = names.find(n => /^\d{1,4}$/.test(n));
      if(numeric) xmlNumber = numeric;
    }
    const rawId = c.getAttribute('id');
    return {
      id: idPrefix + rawId,
      rawId,
      name: dn ? dn.textContent.trim() : rawId,
      icon: icon ? icon.getAttribute('src') : null,
      xmlNumber
    };
  });

  const programmesByCh = {};
  const progNodes = [...doc.getElementsByTagName('programme')];
  for(const p of progNodes){
    const chId = p.getAttribute('channel');
    const start = parseXmltvTime(p.getAttribute('start'));
    const stop = parseXmltvTime(p.getAttribute('stop'));
    if(!chId || !start || !stop) continue;
    const titleEl = p.querySelector('title');
    const descEl = p.querySelector('desc');
    const catEl = p.querySelector('category');
    let titleText = titleEl ? titleEl.textContent.trim() : '';
    if(!titleText || /^no title$/i.test(titleText)) titleText = '(nimetön ohjelma)';
    (programmesByCh[idPrefix + chId] ||= []).push({
      start, stop,
      title: titleText,
      desc: descEl ? descEl.textContent.trim() : '',
      category: catEl ? catEl.textContent.trim() : ''
    });
  }
  for(const id in programmesByCh){
    programmesByCh[id].sort((a,b) => a.start - b.start);
  }
  return { channels, programmesByCh };
}

// ---------- IndexedDB (isot EPG-tiedostot eivät mahdu localStorageen) ----------
const IDB_NAME = 'epgLiveDB';
const IDB_STORE = 'kv';

function idbOpen(){
  return new Promise((resolve, reject) => {
    if(!('indexedDB' in window)){ reject(new Error('IndexedDB ei tuettu')); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbSet(key, value){
  try{
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }catch(e){ return false; }
}
async function idbGet(key){
  try{
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }catch(e){ return null; }
}
async function idbDelete(key){
  try{
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }catch(e){ return false; }
}

// ---------- Monilähdeyhdistely ----------
let loadedSourceData = {}; // avain (url tai 'local-file') -> {label, channels, programmesByCh}

let mergeRenderTimer = null;
function mergeAndRender(){
  clearTimeout(mergeRenderTimer);
  mergeRenderTimer = setTimeout(doMergeAndRender, 150);
}
function doMergeAndRender(){
  const mergedChannels = [];
  const mergedProgrammes = {};
  const seenNames = new Set();
  Object.values(loadedSourceData).forEach(src => {
    src.channels.forEach(ch => {
      const key = chKey(ch.name);
      if(seenNames.has(key)) return; // sama kanava toisesta lähteestä -> ei tuplata
      seenNames.add(key);
      mergedChannels.push(ch);
    });
    Object.assign(mergedProgrammes, src.programmesByCh);
  });
  channels = mergedChannels;
  programmesByCh = mergedProgrammes;
  clearBtn.style.display = mergedChannels.length ? 'inline-flex' : 'none';
  updateCategoryFilterOptions();
  updateLoadedGuideInfo();

  const activeSourceCount = Object.keys(loadedSourceData).length;
  const progCount = Object.values(programmesByCh).reduce((a,b) => a + b.length, 0);
  statusEl.className = '';
  statusEl.textContent = activeSourceCount > 0
    ? `Ladattu ${activeSourceCount} lähteestä · yhteensä ${channels.length} kanavaa, ${progCount} ohjelmaa`
    : '';

  render();
}

function ingestSource(key, xmlText, label){
  const prefix = hashStr(key) + '::';
  const data = parseXmltvData(xmlText, prefix);
  loadedSourceData[key] = { label, channels: data.channels, programmesByCh: data.programmesByCh };
  idbSet('src_xml::' + key, xmlText);
  idbSet('src_label::' + key, label);
  mergeAndRender();
}

function removeSourceData(key){
  delete loadedSourceData[key];
  idbDelete('src_xml::' + key);
  idbDelete('src_label::' + key);
  mergeAndRender();
}

// ---------- File loading (paikallinen tiedosto) ----------
function loadText(text, label){
  try{
    ingestSource('local-file', text, label);
  }catch(err){
    statusEl.className = 'err';
    statusEl.textContent = 'Virhe: ' + err.message;
  }
}

function loadFromUrl(url, name, silent){
  if(!silent){
    statusEl.className = '';
    statusEl.textContent = `Ladataan: ${name || url}…`;
  }
  return fetch(url, { cache: 'no-store' })
    .then(res => {
      if(!res.ok) throw new Error('Palvelin vastasi: ' + res.status);
      return res.text();
    })
    .then(text => {
      ingestSource(url, text, name || url);
      try{ localStorage.setItem('epg_last_fetch::' + url, String(Date.now())); }catch(e){}
    })
    .catch(err => {
      if(silent) return; // taustapäivitys epäonnistui hiljaisesti, yritetään taas myöhemmin
      statusEl.className = 'err';
      statusEl.textContent = `Lähteen lataus epäonnistui (${err.message}). Kyseessä voi olla CORS-esto — kokeile ladata tiedosto koneelle ja avaa se "Avaa opas" -napista.`;
    });
}

// ---------- Automaattinen taustapäivitys kaikille käytössä oleville lähteille ----------
function maybeAutoRefreshSources(){
  sources.forEach(s => {
    if(s.enabled === false) return;
    let lastFetch = 0;
    try{ lastFetch = parseInt(localStorage.getItem('epg_last_fetch::' + s.url) || '0', 10); }catch(e){}
    const hoursSince = (Date.now() - lastFetch) / 3600000;
    if(hoursSince >= 20){
      loadFromUrl(s.url, s.name, true);
    }
  });
}
setInterval(maybeAutoRefreshSources, 60 * 60 * 1000);

// ---------- Sources (URL lähteet) ----------
const DEFAULT_EPG_URL = 'https://raw.githubusercontent.com/teukka79/TV-Opas/main/opas.xml';
const DEFAULT_LOGO_MAP_URL = 'https://raw.githubusercontent.com/teukka79/TV-Opas/main/kanavat.json';
const DEFAULT_SOURCES = [
  { name: 'Oma TV-opas (GitHub)', url: DEFAULT_EPG_URL },
  { name: 'Open-EPG Suomi 1', url: 'https://www.open-epg.com/files/finland1.xml' },
  { name: 'Open-EPG Suomi 2', url: 'https://www.open-epg.com/files/finland2.xml' },
  { name: 'Open-EPG Suomi 3', url: 'https://www.open-epg.com/files/finland3.xml' },
  { name: 'Open-EPG Suomi 4', url: 'https://www.open-epg.com/files/finland4.xml' }
];

let sources = [];
try{ sources = JSON.parse(localStorage.getItem('epg_sources') || '[]'); }catch(e){ sources = []; }
if(!localStorage.getItem('epg_default_sources_seeded_v2')){
  DEFAULT_SOURCES.forEach(def => {
    const existing = sources.find(s => s.url === def.url);
    if(existing) existing.name = def.name; // nimetään olemassa oleva uudelleen pyydetyllä nimellä
    else sources.push({ ...def, enabled: true });
  });
  try{ localStorage.setItem('epg_default_sources_seeded_v2', '1'); }catch(e){}
  try{ localStorage.setItem('epg_sources', JSON.stringify(sources)); }catch(e){}
}

function saveSources(){
  try{ localStorage.setItem('epg_sources', JSON.stringify(sources)); }catch(e){}
}

function renderSources(){
  const list = $('#sourcesList');
  if(sources.length === 0){
    list.innerHTML = `<div class="src-empty">Ei tallennettuja lähteitä vielä.</div>`;
  } else {
    list.innerHTML = sources.map((s, i) => `
      <div class="src-item">
        <div class="src-info">
          <div class="src-name">${escapeHtml(s.name)}</div>
          <div class="src-url">${escapeHtml(s.url)}</div>
        </div>
        <button class="btn small" title="Päivitä nyt" onclick="refreshSource(${i})"><span class="msi" style="font-size:16px">refresh</span></button>
        <label class="switch" title="Käytössä">
          <input type="checkbox" ${s.enabled !== false ? 'checked' : ''} onchange="toggleSourceEnabled(${i}, this.checked)">
          <span class="switch-track"></span>
        </label>
        <button class="btn small danger" onclick="removeSource(${i})"><span class="msi">delete</span></button>
      </div>
    `).join('');
  }
}

function addSource(name, url){
  if(!url) return;
  if(!name) name = url.replace(/^https?:\/\//,'').split('/')[0];
  sources.push({ name, url, enabled: true });
  saveSources();
  renderSources();
  loadFromUrl(url, name, false);
}

function removeSource(i){
  const s = sources[i];
  if(!s) return;
  sources.splice(i, 1);
  saveSources();
  removeSourceData(s.url);
  try{ localStorage.removeItem('epg_last_fetch::' + s.url); }catch(e){}
  renderSources();
}

function refreshSource(i){
  const s = sources[i];
  if(!s) return;
  if(s.enabled === false){ s.enabled = true; saveSources(); renderSources(); }
  loadFromUrl(s.url, s.name, false);
}

function toggleSourceEnabled(i, enabled){
  const s = sources[i];
  if(!s) return;
  s.enabled = enabled;
  saveSources();
  if(enabled){
    loadFromUrl(s.url, s.name, false);
  } else {
    removeSourceData(s.url);
  }
}

$('#addSourceBtn').addEventListener('click', () => {
  const name = $('#srcNameInput').value.trim();
  const url = $('#srcUrlInput').value.trim();
  if(!url){ $('#srcUrlInput').focus(); return; }
  addSource(name, url);
  $('#srcNameInput').value = '';
  $('#srcUrlInput').value = '';
});

$('#suggestBtn').addEventListener('click', () => {
  $('#srcNameInput').value = 'Open-EPG Suomi';
  $('#srcUrlInput').value = 'https://www.open-epg.com/files/finland1.xml';
});

// ---------- Asetusvalikko (välilehdet) ----------
function openSettingsModal(){
  $('#settingsStatus').textContent = '';
  updateLoadedGuideInfo();
  $('#settingsModal').style.display = 'block';
  $('#settingsBackdrop').style.display = 'block';
  switchSettingsTab('sources');
}
function closeSettingsModal(){
  $('#settingsModal').style.display = 'none';
  $('#settingsBackdrop').style.display = 'none';
}

function switchSettingsTab(tab){
  $('#settingsModal').querySelectorAll('.settings-tab').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  $('#settingsModal').querySelectorAll('.settings-panel').forEach(el => {
    el.style.display = (el.id === 'panel-' + tab) ? 'block' : 'none';
  });
  if(tab === 'sources') renderSources();
  else if(tab === 'groups') renderGroupsPanel();
  else if(tab === 'order') initOrderList();
  else if(tab === 'hidden') renderHiddenList();
  else if(tab === 'notif') updateNotifStatusText();
}

function updateLoadedGuideInfo(){
  const el = $('#loadedGuideInfo');
  if(channels.length === 0){
    el.textContent = 'Ei ladattua opasta.';
    return;
  }
  const progCount = Object.values(programmesByCh).reduce((a,b) => a + b.length, 0);
  const srcCount = Object.keys(loadedSourceData).length;
  const srcLabels = Object.values(loadedSourceData).map(s => s.label).join(', ');
  el.textContent = `Ladattu yhteensä: ${channels.length} kanavaa, ${progCount} ohjelmaa, ${srcCount} lähteestä (${srcLabels}).`;
}

// ---------- Kanavaryhmien hallinta ----------
function renderGroupsPanel(){
  $('#groupDetailView').style.display = 'none';
  $('#groupsListView').style.display = 'block';
  const cats = allCategories();
  $('#groupsList').innerHTML = cats.length === 0
    ? `<div class="src-empty">Ei vielä ryhmiä.</div>`
    : cats.map(cat => {
        const count = channels.filter(c => getCategory(c) === cat).length;
        return `<div class="src-item group-row" onclick="openGroupDetail('${cat.replace(/'/g,"\\'")}')">
          <div class="src-info"><div class="src-name">${escapeHtml(cat)}</div><div class="src-url">${count} kanavaa</div></div>
          <button class="btn small" onclick="event.stopPropagation(); renameCategory('${cat.replace(/'/g,"\\'")}')"><span class="msi" style="font-size:15px">edit</span></button>
          <button class="btn small danger" onclick="event.stopPropagation(); deleteCategory('${cat.replace(/'/g,"\\'")}')"><span class="msi" style="font-size:15px">delete</span></button>
        </div>`;
      }).join('');
}

let editingGroupName = null;

function openGroupDetail(cat){
  editingGroupName = cat;
  $('#groupDetailTitle').textContent = cat;
  $('#groupDetailSearch').value = '';
  renderGroupDetailList();
  $('#groupsListView').style.display = 'none';
  $('#groupDetailView').style.display = 'block';
}

function closeGroupDetail(){
  editingGroupName = null;
  renderGroupsPanel();
}

function renderGroupDetailList(){
  const q = $('#groupDetailSearch').value.trim().toLowerCase();
  const list = channels
    .filter(ch => !q || ch.name.toLowerCase().includes(q) || chDisplayName(ch).toLowerCase().includes(q))
    .slice().sort((a,b) => a.name.localeCompare(b.name, 'fi'));
  $('#groupDetailList').innerHTML = list.length === 0
    ? `<div class="src-empty">Ei kanavia.</div>`
    : list.map(ch => {
        const key = chKey(ch.name);
        const checked = getCategory(ch) === editingGroupName;
        const iconSrc = chIcon(ch);
        const iconHtml = iconSrc
          ? `<img class="order-icon-img" src="${escapeHtml(iconSrc)}">`
          : `<div class="order-icon-fallback">${escapeHtml(ch.name.slice(0,2).toUpperCase())}</div>`;
        return `<div class="src-item">
          ${iconHtml}
          <div class="src-info"><div class="src-name">${escapeHtml(chDisplayName(ch))}</div></div>
          <label class="switch">
            <input type="checkbox" ${checked ? 'checked' : ''} onchange="setChannelGroup('${key.replace(/'/g,"\\'")}', this.checked)">
            <span class="switch-track"></span>
          </label>
        </div>`;
      }).join('');
}

function setChannelGroup(key, checked){
  if(!editingGroupName) return;
  const existing = channelMeta[key] || {};
  if(checked){
    channelMeta[key] = { ...existing, category: editingGroupName };
  } else if(existing.category === editingGroupName){
    channelMeta[key] = { ...existing, category: undefined };
  }
  saveChannelMeta();
  updateCategoryFilterOptions();
  render();
}

function renameCategory(oldName){
  const input = prompt('Uusi nimi ryhmälle:', oldName);
  if(!input) return;
  const newName = input.trim();
  if(!newName || newName === oldName) return;
  Object.keys(channelMeta).forEach(key => {
    if(channelMeta[key].category === oldName) channelMeta[key].category = newName;
  });
  saveChannelMeta();
  const idx = knownCategories.indexOf(oldName);
  if(idx !== -1) knownCategories[idx] = newName; else knownCategories.push(newName);
  saveKnownCategories();
  if(activeCategoryFilter === oldName) activeCategoryFilter = newName;
  renderGroupsPanel();
  updateCategoryFilterOptions();
  render();
}

function deleteCategory(name){
  if(!confirm(`Poistetaanko ryhmä "${name}"? Kanavat säilyvät, mutta niiden ryhmämerkintä poistuu.`)) return;
  Object.keys(channelMeta).forEach(key => {
    if(channelMeta[key].category === name) channelMeta[key].category = undefined;
  });
  saveChannelMeta();
  knownCategories = knownCategories.filter(c => c !== name);
  saveKnownCategories();
  if(activeCategoryFilter === name) activeCategoryFilter = 'all';
  renderGroupsPanel();
  updateCategoryFilterOptions();
  render();
}

// ---------- Ilmoitukset suosikkiohjelmille ----------
function updateNotifStatusText(){
  const el = $('#notifStatus');
  if(!('Notification' in window)){
    el.className = 'ch-url-status err';
    el.textContent = 'Tämä selain ei tue ilmoituksia.';
    return;
  }
  if(Notification.permission === 'granted'){
    el.className = 'ch-url-status';
    el.textContent = 'Ilmoitukset käytössä. Merkitse kanavia suosikeiksi (★) saadaksesi muistutuksen 5 min ennen ohjelman alkua.';
  } else if(Notification.permission === 'denied'){
    el.className = 'ch-url-status err';
    el.textContent = 'Ilmoitukset estetty selaimen asetuksista. Salli ne selaimen sivustoasetuksista käyttääksesi tätä.';
  } else {
    el.className = 'ch-url-status';
    el.textContent = '';
  }
}

function requestNotificationPermission(){
  if(!('Notification' in window)){ updateNotifStatusText(); return; }
  Notification.requestPermission().then(() => updateNotifStatusText());
}

let notifiedPrograms = new Set();
function checkFavoriteNotifications(){
  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  channels.filter(isFavorite).forEach(ch => {
    const list = programmesByCh[ch.id] || [];
    list.forEach(p => {
      const minutesUntil = (p.start - now) / 60000;
      if(minutesUntil > 0 && minutesUntil <= 5){
        const key = ch.id + '|' + p.start.getTime();
        if(!notifiedPrograms.has(key)){
          notifiedPrograms.add(key);
          try{
            const n = new Notification(`${p.title} alkaa pian`, {
              body: `${ch.name} · klo ${fmtTime(p.start)}`,
              icon: chIcon(ch) || undefined,
              tag: key
            });
            n.onclick = () => { window.focus(); n.close(); };
          }catch(e){}
        }
      }
    });
  });
}
setInterval(checkFavoriteNotifications, 30000);

function exportSettings(){
  const data = {
    channelMeta, sources, channelOrder, knownCategories,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${pad(now.getDate())}-${pad(now.getMonth()+1)}-${now.getFullYear()}`;
  const timeStr = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const a = document.createElement('a');
  a.href = url;
  a.download = `epg-live-asetukset_${dateStr}_${timeStr}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importSettingsFile(file){
  const reader = new FileReader();
  reader.onload = e => {
    try{
      const data = JSON.parse(e.target.result);
      if(data.channelMeta && typeof data.channelMeta === 'object') channelMeta = data.channelMeta;
      if(Array.isArray(data.sources)) sources = data.sources;
      if(Array.isArray(data.channelOrder)) channelOrder = data.channelOrder;
      if(Array.isArray(data.knownCategories)) knownCategories = data.knownCategories;
      saveChannelMeta(); saveSources(); saveChannelOrder(); saveKnownCategories();
      updateCategoryFilterOptions();
      $('#settingsStatus').className = 'ch-url-status';
      $('#settingsStatus').textContent = 'Asetukset tuotu onnistuneesti.';
      render();
    }catch(err){
      $('#settingsStatus').className = 'ch-url-status err';
      $('#settingsStatus').textContent = 'Tiedoston luku epäonnistui: virheellinen varmuuskopiotiedosto.';
    }
  };
  reader.readAsText(file);
}
$('#importSettingsInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if(f) importSettingsFile(f);
});

function resetAllSettings(){
  if(!confirm('Poistetaanko kaikki kanavien mukautukset, lähteet ja järjestys? Tätä ei voi perua.')) return;
  channelMeta = {}; sources = []; channelOrder = []; knownCategories = [...DEFAULT_CATEGORIES];
  try{
    localStorage.removeItem('epg_channel_meta');
    localStorage.removeItem('epg_sources');
    localStorage.removeItem('epg_channel_order');
  }catch(e){}
  saveKnownCategories();
  updateCategoryFilterOptions();
  $('#settingsStatus').className = 'ch-url-status';
  $('#settingsStatus').textContent = 'Kaikki mukautukset nollattu.';
  render();
}

// ---------- Kanavan mukautukset: logo + numero ----------
let channelMeta = {};
try{ channelMeta = JSON.parse(localStorage.getItem('epg_channel_meta') || '{}'); }catch(e){ channelMeta = {}; }

function chKey(name){ return (name || '').trim().toLowerCase(); }
function getMeta(name){ return channelMeta[chKey(name)] || {}; }
function chDisplayName(ch){
  const m = getMeta(ch.name);
  return (m.customName && m.customName.trim()) || ch.name;
}
function saveChannelMeta(){
  try{ localStorage.setItem('epg_channel_meta', JSON.stringify(channelMeta)); return true; }
  catch(e){ return false; }
}
function chIcon(ch){
  const m = getMeta(ch.name);
  if(m.logo) return m.logo;
  const mapped = lookupLogoMap(ch);
  if(mapped) return mapped;
  return ch.icon || null;
}

// ---------- Logolähde (esim. GitHubiin tallennettu kanavat.json) ----------
let logoMap = null;
try{ logoMap = JSON.parse(localStorage.getItem('epg_logo_map') || 'null'); }catch(e){ logoMap = null; }

function chLookupIds(ch){
  const ids = [];
  
  if(ch.rawId) ids.push(ch.rawId);
  
  if(ch.id && ch.id.includes('::')) {
    const parts = ch.id.split('::');
    const stripped = parts[parts.length - 1];
    if(stripped && !ids.includes(stripped)) ids.push(stripped);
  } else if(ch.id && !ids.includes(ch.id)) {
    ids.push(ch.id);
  }
  
  return ids;
}

function lookupLogoMap(ch){
  if(!logoMap || !logoMap.byId) return null;
  for(const id of chLookupIds(ch)){
    if(logoMap.byId[id]) return logoMap.byId[id];
    const lower = logoMap.byId[id.toLowerCase()];
    if(lower) return lower;
  }
  if(logoMap.byName){
    const nk = chKey(ch.name);
    if(logoMap.byName[nk]) return logoMap.byName[nk];
    const nkNoTld = nk.replace(/\.(fi|uk|se|no|dk|de|us)$/, '');
    if(nkNoTld !== nk && logoMap.byName[nkNoTld]) return logoMap.byName[nkNoTld];
  }
  return null;
}

function lookupLogoMapNumber(ch){
  if(!logoMap) return null;
  if(logoMap.numById){
    for(const id of chLookupIds(ch)){
      if(logoMap.numById[id] !== undefined) return logoMap.numById[id];
      const lower = logoMap.numById[id.toLowerCase()];
      if(lower !== undefined) return lower;
    }
  }
  if(logoMap.numByName){
    const nk = chKey(ch.name);
    if(logoMap.numByName[nk] !== undefined) return logoMap.numByName[nk];
    const nkNoTld = nk.replace(/\.(fi|uk|se|no|dk|de|us)$/, '');
    if(nkNoTld !== nk && logoMap.numByName[nkNoTld] !== undefined) return logoMap.numByName[nkNoTld];
  }
  return null;
}

function buildLogoMapFromArray(arr){
  const byId = {}, byName = {}, numById = {}, numByName = {};
  arr.forEach(entry => {
    const logo = entry.logo || entry.icon;
    const num = entry.numero !== undefined ? entry.numero : entry.number;

    const ids = [];
    const addIds = v => { if(Array.isArray(v)) ids.push(...v); else if(v) ids.push(v); };
    addIds(entry.xmltv_id);
    addIds(entry.id);

    ids.forEach(id => {
      if(typeof id !== 'string' || !id) return;
      if(logo){ byId[id] = logo; byId[id.toLowerCase()] = logo; }
      if(num !== undefined && num !== null && num !== ''){
        numById[id] = num; numById[id.toLowerCase()] = num;
      }
    });

    const names = [];
    if(entry.nimi) names.push(entry.nimi);
    if(entry.name) names.push(entry.name);
    names.forEach(n => {
      const key = chKey(n);
      if(logo) byName[key] = logo;
      if(num !== undefined && num !== null && num !== '') numByName[key] = num;
    });
  });
  return { byId, byName, numById, numByName };
}

function fetchLogoMap(url, silent){
  if(!silent){
    $('#logoMapStatus').className = 'ch-url-status';
    $('#logoMapStatus').textContent = 'Haetaan…';
  }
  return fetch(url, { cache: 'no-store' })
    .then(res => { if(!res.ok) throw new Error('Palvelin vastasi: ' + res.status); return res.json(); })
    .then(data => {
      const arr = Array.isArray(data) ? data : (data.channels || data.kanavat || []);
      if(!Array.isArray(arr) || arr.length === 0) throw new Error('Tiedostosta ei löytynyt kanavalistaa.');
      logoMap = buildLogoMapFromArray(arr);
      try{
        localStorage.setItem('epg_logo_map', JSON.stringify(logoMap));
        localStorage.setItem('epg_logo_map_url', url);
      }catch(e){}
      if($('#logoMapStatus')){
        $('#logoMapStatus').className = 'ch-url-status';
        $('#logoMapStatus').textContent = `${arr.length} kanavan logotiedot ladattu.`;
      }
      render();
    })
    .catch(err => {
      if($('#logoMapStatus')){
        $('#logoMapStatus').className = 'ch-url-status err';
        $('#logoMapStatus').textContent = `Haku epäonnistui (${err.message}). Tarkista että linkki on suora raw-JSON-osoite ja sallii CORS-haun.`;
      }
    });
}

$('#fetchLogoMapBtn').addEventListener('click', () => {
  const url = $('#logoMapUrlInput').value.trim();
  if(!url){ $('#logoMapUrlInput').focus(); return; }
  fetchLogoMap(url, false);
});

(function initLogoMapUrl(){
  try{
    const savedUrl = localStorage.getItem('epg_logo_map_url');
    $('#logoMapUrlInput').value = savedUrl || DEFAULT_LOGO_MAP_URL;
  }catch(e){}
})();

function chNumber(ch){
  const m = getMeta(ch.name);
  if(m.number) return String(m.number).trim();
  const mapped = lookupLogoMapNumber(ch);
  if(mapped !== null && mapped !== undefined && mapped !== '') return String(mapped);
  return (ch.xmlNumber || '').trim();
}

function channelMatchesQuery(ch, q){
  if(!q) return true;
  if(ch.name.toLowerCase().includes(q)) return true;
  if(chDisplayName(ch).toLowerCase().includes(q)) return true;
  const list = programmesByCh[ch.id] || [];
  return list.some(p =>
    (p.title && p.title.toLowerCase().includes(q)) ||
    (p.desc && p.desc.toLowerCase().includes(q))
  );
}

function isHidden(ch){ return !!getMeta(ch.name).hidden; }
function isFavorite(ch){ return !!getMeta(ch.name).favorite; }

function toggleFavorite(name){
  const key = chKey(name);
  const existing = channelMeta[key] || {};
  channelMeta[key] = { ...existing, favorite: !existing.favorite || undefined };
  saveChannelMeta();
  render();
}

function getCategory(ch){ return (getMeta(ch.name).category || '').trim(); }

// ---------- Tunnetut ryhmät ----------
const DEFAULT_CATEGORIES = ['Peruskanavat', 'Elokuvat & Sarjat', 'Urheilu'];
let knownCategories = null;
try{ knownCategories = JSON.parse(localStorage.getItem('epg_known_categories') || 'null'); }catch(e){}
if(!Array.isArray(knownCategories)){
  knownCategories = [...DEFAULT_CATEGORIES];
  try{ localStorage.setItem('epg_known_categories', JSON.stringify(knownCategories)); }catch(e){}
}
function saveKnownCategories(){
  try{ localStorage.setItem('epg_known_categories', JSON.stringify(knownCategories)); }catch(e){}
}
function registerCategory(name){
  if(name && !knownCategories.includes(name)){
    knownCategories.push(name);
    saveKnownCategories();
  }
}

function allCategories(){
  const set = new Set(knownCategories);
  Object.values(channelMeta).forEach(m => { if(m.category) set.add(m.category); });
  return [...set].sort((a,b) => a.localeCompare(b,'fi'));
}

// ---------- Kanavaryhmäsuodatin ----------
let activeCategoryFilter = localStorage.getItem('epg_category_filter') || 'all';

function updateCategoryFilterOptions(){
  const sel = $('#categoryFilterSelect');
  const cats = allCategories();
  const hasUncategorized = channels.some(c => !getCategory(c));
  sel.innerHTML = `<option value="all">Kaikki ryhmät</option>` +
    cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('') +
    (hasUncategorized ? `<option value="__none__">Ryhmittelemättömät</option>` : '');
  const validValues = ['all', '__none__', ...cats];
  sel.value = validValues.includes(activeCategoryFilter) ? activeCategoryFilter : 'all';
  activeCategoryFilter = sel.value;
}

function onCategoryFilterChange(){
  activeCategoryFilter = $('#categoryFilterSelect').value;
  try{ localStorage.setItem('epg_category_filter', activeCategoryFilter); }catch(e){}
  render();
}

function channelPassesCategoryFilter(ch){
  if(activeCategoryFilter === 'all') return true;
  if(activeCategoryFilter === '__none__') return !getCategory(ch);
  return getCategory(ch) === activeCategoryFilter;
}

function renderHiddenList(){
  const q = ($('#hiddenSearchInput').value || '').trim().toLowerCase();
  const list = channels
    .filter(ch => !q || ch.name.toLowerCase().includes(q) || chDisplayName(ch).toLowerCase().includes(q))
    .slice().sort((a,b) => a.name.localeCompare(b.name, 'fi'));
  const hiddenCount = channels.filter(isHidden).length;
  $('#hiddenSummary').textContent = `${hiddenCount} / ${channels.length} kanavaa piilotettu`;

  $('#hiddenList').innerHTML = list.length === 0
    ? `<div class="src-empty">Ei kanavia.</div>`
    : list.map(ch => {
        const key = chKey(ch.name);
        const hidden = isHidden(ch);
        const iconSrc = chIcon(ch);
        const iconHtml = iconSrc
          ? `<img class="order-icon-img" src="${escapeHtml(iconSrc)}">`
          : `<div class="order-icon-fallback">${escapeHtml(ch.name.slice(0,2).toUpperCase())}</div>`;
        return `<div class="src-item">
          ${iconHtml}
          <div class="src-info"><div class="src-name">${escapeHtml(chDisplayName(ch))}</div></div>
          <label class="switch">
            <input type="checkbox" ${hidden ? 'checked' : ''} onchange="setChannelHidden('${key.replace(/'/g,"\\'")}', this.checked)">
            <span class="switch-track"></span>
          </label>
        </div>`;
      }).join('');
}

function setChannelHidden(key, hidden){
  channelMeta[key] = { ...(channelMeta[key] || {}), hidden: hidden || undefined };
  saveChannelMeta();
  $('#hiddenSummary').textContent = `${channels.filter(isHidden).length} / ${channels.length} kanavaa piilotettu`;
  render();
}

function hideAllChannels(){
  if(!confirm('Piilotetaanko kaikki kanavat? Voit sen jälkeen kääntää kytkimillä näkyviin ne joita haluat katsoa.')) return;
  channels.forEach(ch => {
    const key = chKey(ch.name);
    channelMeta[key] = { ...(channelMeta[key] || {}), hidden: true };
  });
  saveChannelMeta();
  renderHiddenList();
  render();
}

// Korjattu hieman pätkäisevää tagia edellisestä raakakoodista varmistamaan oikea toiminta
function showAllChannels(){
  channels.forEach(ch => {
    const key = chKey(ch.name);
    if(channelMeta[key]) channelMeta[key].hidden = undefined;
  });
  saveChannelMeta();
  renderHiddenList();
  render();
}

// ---------- Kanavien järjestys ----------
let channelOrder = [];
try{ channelOrder = JSON.parse(localStorage.getItem('epg_channel_order') || '[]'); }catch(e){ channelOrder = []; }

function saveChannelOrder(){
  try{ localStorage.setItem('epg_channel_order', JSON.stringify(channelOrder)); }catch(e){}
}

function channelSortNumber(ch){
  const n = parseInt(chNumber(ch), 10);
  return isNaN(n) ? null : n;
}

function sortChannels(list){
  return list.slice().sort((a, b) => {
    const fa = isFavorite(a) ? 0 : 1;
    const fb = isFavorite(b) ? 0 : 1;
    if(fa !== fb) return fa - fb;

    const ia = channelOrder.indexOf(chKey(a.name));
    const ib = channelOrder.indexOf(chKey(b.name));
    if(ia !== -1 && ib !== -1) return ia - ib;
    if(ia !== -1) return -1;
    if(ib !== -1) return 1;

    const na = channelSortNumber(a);
    const nb = channelSortNumber(b);
    if(na !== null && nb !== null) return na - nb;
    if(na !== null) return -1;
    if(nb !== null) return 1;

    return chDisplayName(a).localeCompare(chDisplayName(b), 'fi');
  });
}

function initOrderList(){
  const known = channels.map(c => chKey(c.name));
  if(channelOrder.length === 0){
    channelOrder = sortChannels(channels).map(c => chKey(c.name));
  } else {
    known.forEach(k => { if(!channelOrder.includes(k)) channelOrder.push(k); });
    channelOrder = channelOrder.filter(k => known.includes(k));
  }
  renderOrderList();
}

function renderOrderList(){
  $('#orderList').innerHTML = channelOrder.map((key) => {
    const ch = channels.find(c => chKey(c.name) === key);
    if(!ch) return '';
    const iconSrc = chIcon(ch);
    const iconHtml = iconSrc
      ? `<img class="order-icon-img" src="${escapeHtml(iconSrc)}">`
      : `<div class="order-icon-fallback">${escapeHtml(ch.name.slice(0,2).toUpperCase())}</div>`;
    const k = key.replace(/'/g,"\\'");
    return `<div class="order-item" data-key="${escapeHtml(key)}">
      <div class="order-item-top">
        <span class="msi order-handle">drag_indicator</span>
        ${iconHtml}
        <div class="src-info"><div class="src-name">${escapeHtml(chDisplayName(ch))}</div></div>
      </div>
      <div class="order-item-actions">
        <button class="btn small" title="Ylimmäiseksi" onclick="moveChannelTop('${k}')"><span class="msi" style="font-size:15px">vertical_align_top</span></button>
        <button class="btn small" title="5 riviä ylös" onclick="moveChannelBy('${k}', -5)"><span class="msi" style="font-size:15px">keyboard_double_arrow_up</span></button>
        <button class="btn small" title="1 rivi ylös" onclick="moveChannelBy('${k}', -1)"><span class="msi" style="font-size:15px">keyboard_arrow_up</span></button>
        <button class="btn small" title="1 rivi alas" onclick="moveChannelBy('${k}', 1)"><span class="msi" style="font-size:15px">keyboard_arrow_down</span></button>
        <button class="btn small" title="5 riviä alas" onclick="moveChannelBy('${k}', 5)"><span class="msi" style="font-size:15px">keyboard_double_arrow_down</span></button>
        <button class="btn small" title="Alimmaiseksi" onclick="moveChannelBottom('${k}')"><span class="msi" style="font-size:15px">vertical_align_bottom</span></button>
      </div>
    </div>`;
  }).join('');
  attachOrderDragHandlers();
}

function moveChannelTop(key){
  const i = channelOrder.indexOf(key);
  if(i <= 0) return;
  channelOrder.splice(i, 1);
  channelOrder.unshift(key);
  saveChannelOrder();
  renderOrderList();
  render();
}

// Tästä eteenpäin koodi jatkuu tismalleen alkuperäisen pohjan mukaisesti
function moveChannelBottom(key){
  const i = channelOrder.indexOf(key);
  if(i === -1 || i === channelOrder.length - 1) return;
  channelOrder.splice(i, 1);
  channelOrder.push(key);
  saveChannelOrder();
  renderOrderList();
  render();
}

function moveChannelBy(key, delta){
  const i = channelOrder.indexOf(key);
  if(i === -1) return;
  const j = Math.max(0, Math.min(channelOrder.length - 1, i + delta));
  if(j === i) return;
  channelOrder.splice(i, 1);
  channelOrder.splice(j, 0, key);
  saveChannelOrder();
  renderOrderList();
  render();
}

// ---------- Kanavien raahaus ----------
let orderDragEl = null;
let orderDragStartY = 0;

function attachOrderDragHandlers(){
  $('#orderList').querySelectorAll('.order-handle').forEach(handle => {
    handle.addEventListener('pointerdown', onOrderDragStart);
  });
}

function onOrderDragStart(e){
  e.preventDefault();
  orderDragEl = e.target.closest('.order-item');
  orderDragStartY = e.clientY;
  orderDragEl.classList.add('dragging');
  orderDragEl.setPointerCapture(e.pointerId);
  orderDragEl.addEventListener('pointermove', onOrderDragMove);
  orderDragEl.addEventListener('pointerup', onOrderDragEnd);
  orderDragEl.addEventListener('pointercancel', onOrderDragEnd);
}

function onOrderDragMove(e){
  if(!orderDragEl) return;
  const list = $('#orderList');
  const siblings = [...list.querySelectorAll('.order-item')].filter(el => el !== orderDragEl);
  for(const sib of siblings){
    const rect = sib.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if(e.clientY < mid){
      if(sib.previousElementSibling !== orderDragEl) list.insertBefore(orderDragEl, sib);
      return;
    }
  }
  if(list.lastElementChild !== orderDragEl) list.appendChild(orderDragEl);
}

function onOrderDragEnd(e){
  if(!orderDragEl) return;
  orderDragEl.classList.remove('dragging');
  orderDragEl.removeEventListener('pointermove', onOrderDragMove);
  orderDragEl.removeEventListener('pointerup', onOrderDragEnd);
  orderDragEl.removeEventListener('pointercancel', onOrderDragEnd);
  channelOrder = [...$('#orderList').querySelectorAll('.order-item')].map(el => el.dataset.key);
  saveChannelOrder();
  orderDragEl = null;
  render();
}

function resizeImageFile(file, maxSize, cb){
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if(w > h){ if(w > maxSize){ h = Math.round(h*maxSize/w); w = maxSize; } }
      else { if(h > maxSize){ w = Math.round(w*maxSize/h); h = maxSize; } }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(canvas.toDataURL('image/png', 0.9));
    };
    img.onerror = () => cb(null);
    img.src = e.target.result;
  };
  reader.onerror = () => cb(null);
  reader.readAsDataURL(file);
}

let editingChannel = null;

function openChannelEdit(name){
  editingChannel = name;
  const m = getMeta(name);
  const ch = channels.find(c => c.name === name);
  const currentLogo = m.logo || (ch && ch.icon) || '';
  const categoryOptions = allCategories().map(c => `<option value="${escapeHtml(c)}">`).join('');
  $('#chEditSheet').innerHTML = `
    <button class="close" onclick="closeChannelEdit()"><span class="msi">close</span></button>
    <h3>${escapeHtml(m.customName || name)}</h3>
    <label class="field-label">Kanavan nimi</label>
    <input type="text" id="chNameInput" class="search" style="width:100%" placeholder="${escapeHtml(name)}" value="${escapeHtml(m.customName || '')}">
    <div class="ch-edit-preview">
      <img id="chEditPreview" src="${escapeHtml(currentLogo)}" onerror="this.style.opacity=0">
    </div>
    <label class="field-label">Lataa kuvake omalta koneelta (PNG/JPG)</label>
    <input type="file" id="chLogoInput" accept="image/*">
    <label class="field-label">Tai hae kuva linkistä</label>
    <div class="logo-url-row">
      <input type="text" id="chLogoUrlInput" class="search" placeholder="https://…/logo.png" value="${/^https?:\/\//.test(currentLogo) ? escapeHtml(currentLogo) : ''}">
      <button class="btn" id="useLogoUrlBtn" type="button">Käytä</button>
    </div>
    <div class="ch-url-status" id="chUrlStatus"></div>
    <label class="field-label">Kanavanumero</label>
    <input type="text" id="chNumberInput" class="search" style="width:100%" placeholder="esim. 118" value="${escapeHtml(m.number || (ch ? ch.xmlNumber : '') || '')}">
    <label class="field-label">Kategoria / ryhmä</label>
    <input type="text" id="chCategoryInput" class="search" style="width:100%" list="categoryOptions" placeholder="esim. Urheilu, Uutiset, Lapset…" value="${escapeHtml(m.category || '')}">
    <datalist id="categoryOptions">${categoryOptions}</datalist>
    <label class="ch-hide-row">
      <input type="checkbox" id="chFavoriteInput" ${m.favorite ? 'checked' : ''}>
      <span>★ Merkitse suosikiksi (nostetaan listan kärkeen)</span>
    </label>
    <label class="ch-hide-row">
      <input type="checkbox" id="chHiddenInput" ${m.hidden ? 'checked' : ''}>
      <span>Piilota tämä kanava listoista</span>
    </label>
    <div class="ch-edit-actions">
      <button class="btn" onclick="resetChannelMeta()">Poista mukautukset</button>
      <button class="btn primary" onclick="saveChannelEdit()">Tallenna</button>
    </div>
  `;
  $('#chEditSheet').style.display = 'block';
  $('#tlBackdrop').style.display = 'block';
  $('#chLogoInput').addEventListener('change', e => {
    const f = e.target.files[0];
    if(!f) return;
    resizeImageFile(f, 128, dataUrl => {
      if(dataUrl) $('#chEditPreview').src = dataUrl;
      $('#chEditPreview').dataset.pending = dataUrl || '';
      $('#chUrlStatus').textContent = '';
    });
  });
  $('#useLogoUrlBtn').addEventListener('click', () => {
    const url = $('#chLogoUrlInput').value.trim();
    if(!url){ $('#chLogoUrlInput').focus(); return; }
    const test = new Image();
    test.onload = () => {
      $('#chEditPreview').src = url;
      $('#chEditPreview').dataset.pending = url;
      $('#chUrlStatus').className = 'ch-url-status';
      $('#chUrlStatus').textContent = 'Kuva löytyi ja on valmis tallennettavaksi.';
    };
    test.onerror = () => {
      $('#chUrlStatus').className = 'ch-url-status err';
      $('#chUrlStatus').textContent = 'Kuvaa ei saatu ladattua tuosta linkistä.';
    };
    test.src = url;
  });
}

function saveChannelEdit(){
  if(!editingChannel) return;
  const key = chKey(editingChannel);
  const customName = $('#chNameInput').value.trim();
  const number = $('#chNumberInput').value.trim();
  const category = $('#chCategoryInput').value.trim();
  const hidden = $('#chHiddenInput').checked;
  const favorite = $('#chFavoriteInput').checked;
  const pendingLogo = $('#chEditPreview').dataset.pending;
  const existing = channelMeta[key] || {};
  channelMeta[key] = {
    customName: (customName && customName !== editingChannel) ? customName : undefined,
    number: number || undefined,
    category: category || undefined,
    hidden: hidden || undefined,
    favorite: favorite || undefined,
    logo: pendingLogo || existing.logo || undefined
  };
  const ok = saveChannelMeta();
  if(category) registerCategory(category);
  if(!ok){
    $('#chUrlStatus').className = 'ch-url-status err';
    $('#chUrlStatus').textContent = 'Tallennus epäonnistui – selaimen tallennustila on täynnä. Kokeile pienempää kuvaa, tai varmuuskopioi/tyhjennä asetuksia "⚙ Asetukset" -valikosta.';
    return;
  }
  updateCategoryFilterOptions();
  closeChannelEdit();
  render();
}

function resetChannelMeta(){
  if(!editingChannel) return;
  delete channelMeta[chKey(editingChannel)];
  saveChannelMeta();
  updateCategoryFilterOptions();
  closeChannelEdit();
  render();
}

function closeChannelEdit(){
  editingChannel = null;
  $('#chEditSheet').style.display = 'none';
  if($('#tlSheet').style.display !== 'block') $('#tlBackdrop').style.display = 'none';
}

fileInput.addEventListener('change', e => {
  const f = e.target.files[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = ev => loadText(ev.target.result, f.name);
  reader.onerror = () => { statusEl.className='err'; statusEl.textContent = 'Tiedoston luku epäonnistui.'; };
  reader.readAsText(f);
});

['dragenter','dragover'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.add('drag');
}));
['dragleave','drop'].forEach(ev => dropzone.addEventListener(ev, e => {
  e.preventDefault(); dropzone.classList.remove('drag');
}));
dropzone.addEventListener('drop', e => {
  const f = e.dataTransfer.files[0];
  if(!f) return;
  const reader = new FileReader();
  reader.onload = ev => loadText(ev.target.result, f.name);
  reader.readAsText(f);
});

clearBtn.addEventListener('click', () => {
  loadedSourceData = {};
  channels = []; programmesByCh = {}; expandedId = null;
  const keys = new Set(['local-file']);
  sources.forEach(s => keys.add(s.url));
  keys.forEach(k => { idbDelete('src_xml::' + k); idbDelete('src_label::' + k); });
  idbDelete('epg_xml'); idbDelete('epg_label');
  try{ localStorage.removeItem('epg_xml'); localStorage.removeItem('epg_label'); }catch(e){}
  statusEl.textContent = ''; clearBtn.style.display = 'none';
  updateLoadedGuideInfo();
  render();
});

// palauta kaikki käytössä olevat lähteet
(async function restore(){
  try{
    const legacy = await idbGet('epg_xml');
    if(legacy){
      const legacyLabel = await idbGet('epg_label');
      try{ ingestSource('local-file', legacy, legacyLabel || 'tallennettu opas'); }catch(e){}
      idbDelete('epg_xml'); idbDelete('epg_label');
    }

    let anyCached = false;
    for(const s of sources){
      if(s.enabled === false) continue;
      const cached = await idbGet('src_xml::' + s.url);
      if(cached){
        try{ ingestSource(s.url, cached, s.name); anyCached = true; }catch(e){}
      }
    }

    sources.forEach(s => {
      if(s.enabled === false) return;
      loadFromUrl(s.url, s.name, true);
    });
  }catch(e){}

  if(logoMap && (!logoMap.byId || typeof logoMap.byId !== 'object')){
    logoMap = null;
    try{ localStorage.removeItem('epg_logo_map'); }catch(e){}
  }
  (function(){
    let logoUrl = DEFAULT_LOGO_MAP_URL;
    try{ logoUrl = localStorage.getItem('epg_logo_map_url') || DEFAULT_LOGO_MAP_URL; }catch(e){}
    fetchLogoMap(logoUrl, true);
  })();

  setTimeout(maybeAutoRefreshSources, 4000);
})();

// ---------- Rendering ----------
function findCurrent(list, now){
  return list.find(p => p.start <= now && now < p.stop) || null;
}
function findNext(list, now){
  return list.find(p => p.start > now) || null;
}
function findNextN(list, now, n){
  return list.filter(p => p.start > now).slice(0, n);
}
function fmtTime(d){
  return d.toLocaleTimeString('fi-FI', {hour:'2-digit', minute:'2-digit'});
}
function fmtRemaining(ms){
  const min = Math.max(0, Math.round(ms/60000));
  if(min < 60) return `${min} min jäljellä`;
  const h = Math.floor(min/60), m = min%60;
  return `${h} h ${m} min jäljellä`;
}
const HTML_ESCAPE_MAP = {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c => HTML_ESCAPE_MAP[c]);
}

let currentView = 'cards';
let pxPerMin = 6;
let tlGlobalMin = null;
let tlGlobalMax = null;
let tlWindowStart = null;
let tlWindowEnd = null;
let tlDateInited = false;
let tlInited = false;

function setView(v){
  currentView = v;
  $('#viewCardsBtn').classList.toggle('active', v === 'cards');
  $('#viewTimelineBtn').classList.toggle('active', v === 'timeline');
  $('#main').style.display = v === 'cards' ? '' : 'none';
  $('#timelineView').style.display = v === 'timeline' ? 'flex' : 'none';
  render();
  if(v === 'timeline' && !tlInited){
    tlInited = true;
    requestAnimationFrame(() => setTimeout(tlJumpNow, 30));
  }
}

let searchDebounceTimer = null;
function onSearchInput(){
  clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(render, 150);
}

function render(){
  const main = $('#main');
  const empty = $('#emptyState');

  if(channels.length === 0){
    main.innerHTML = '';
    empty.style.display = 'block';
    $('#tlChCol').innerHTML = '';
    $('#tlHContent').innerHTML = '';
    return;
  }
  empty.style.display = 'none';

  if(currentView === 'cards') renderCards();
  else renderTimeline();
}

function renderCards(){
  const q = $('#search').value.trim().toLowerCase();
  const now = new Date();
  const main = $('#main');

  const filtered = sortChannels(channels.filter(c => !isHidden(c) && channelPassesCategoryFilter(c) && channelMatchesQuery(c, q)));

  main.innerHTML = filtered.map(ch => cardHtmlFor(ch, now)).join('');
}

function cardHtmlFor(ch, now){
  const list = programmesByCh[ch.id] || [];
  const cur = findCurrent(list, now);
  const next3 = findNextN(list, now, 3);
  const isExpanded = expandedId === ch.id;

  const upcomingHtml = next3.length ? `
    <div class="c2-upcoming">
      ${next3.map(p => `<div class="c2-up-item" onclick="event.stopPropagation(); showProgramSheetByTime('${ch.id.replace(/'/g,"\\'")}', ${p.start.getTime()})">
        <span class="c2-up-time">${fmtTime(p.start)}</span>${escapeHtml(p.title)}
      </div>`).join('')}
    </div>` : '';

  let bodyHtml;
  if(cur){
    const total = cur.stop - cur.start;
    const elapsed = now - cur.start;
    const pct = Math.min(100, Math.max(0, (elapsed/total)*100));
    bodyHtml = `
      <div class="c2-title-row">
        <span class="c2-title" onclick="event.stopPropagation(); showProgramSheetByTime('${ch.id.replace(/'/g,"\\'")}', ${cur.start.getTime()})">${escapeHtml(cur.title)}</span>
        <span class="live-dot"></span>
        <span class="c2-remaining">(${fmtRemaining(cur.stop - now)})</span>
      </div>
      <div class="c2-meta-row">
        <span>${fmtTime(cur.start)}–${fmtTime(cur.stop)}${cur.category ? ` · ${escapeHtml(cur.category)}` : ''} <span class="badge live">LIVE</span></span>
      </div>
      <div class="progress-wrap"><div class="progress-bar" style="width:${pct}%"></div></div>
      ${upcomingHtml}
    `;
  } else {
    bodyHtml = `<div class="no-info">Ei ohjelmatietoa juuri nyt</div>${upcomingHtml}`;
  }

  let scheduleHtml = '';
  if(isExpanded){
    const upcoming = list.filter(p => p.stop > now).slice(0, 12);
    scheduleHtml = `<div class="schedule">` + upcoming.map(p => {
      const isCur = p === cur;
      return `<div class="sched-item ${isCur ? 'current' : ''}" onclick="event.stopPropagation(); showProgramSheetByTime('${ch.id.replace(/'/g,"\\'")}', ${p.start.getTime()})">
        <div class="t">${fmtTime(p.start)}–${fmtTime(p.stop)}</div>
        <div>${isCur ? '<b>' : ''}${escapeHtml(p.title)}${isCur ? '</b>' : ''}</div>
      </div>`;
    }).join('') + `</div>`;
  }

  const iconSrc = chIcon(ch);
  const num = chNumber(ch);
  const fav = isFavorite(ch);
  const iconInner = iconSrc
    ? `<img class="ch-icon" src="${escapeHtml(iconSrc)}" onerror="this.style.display='none'">`
    : `<div class="ch-icon-name">${escapeHtml(chDisplayName(ch))}</div>`;
  const iconHtml = `
    <div class="icon-wrap">
      <div onclick="event.stopPropagation(); openChannelEdit('${ch.name.replace(/'/g,"\\'")}')">
        ${iconInner}
      </div>
      <div class="icon-footer">
        <div class="edit-pencil-btn" title="Muokkaa" onclick="event.stopPropagation(); openChannelEdit('${ch.name.replace(/'/g,"\\'")}')">
          <span class="msi">edit</span>
        </div>
        <div class="fav-star-btn ${fav ? 'active' : ''}" title="Suosikki" onclick="event.stopPropagation(); toggleFavorite('${ch.name.replace(/'/g,"\\'")}')">
          <span class="msi ${fav ? 'filled' : ''}">star</span>
        </div>
        ${num ? `<div class="ch-number-chip">${escapeHtml(num)}</div>` : ''}
      </div>
    </div>`;

  return `
    <div class="card ${isExpanded ? 'expanded' : ''}" onclick="toggleExpand('${ch.id.replace(/'/g,"\\'")}')">
      <div class="card-icon-col">${iconHtml}</div>
      <div class="card-content">
        ${bodyHtml}
        ${scheduleHtml}
      </div>
    </div>
  `;
}

function toggleExpand(id){
  expandedId = expandedId === id ? null : id;
  render();
}

// ---------- Timeline view ----------
const TL_ROW_HEIGHT = 82;
let tlRows = [];
let tlBuildData = null;

function renderTimeline(){
  const q = $('#search').value.trim().toLowerCase();
  const now = new Date();

  const filtered = sortChannels(channels.filter(c => !isHidden(c) && channelPassesCategoryFilter(c) && channelMatchesQuery(c, q)));
  tlRows = filtered.map(ch => ({ type: 'channel', ch }));

  let allProgs = [];
  filtered.forEach(c => { allProgs = allProgs.concat(programmesByCh[c.id] || []); });

  let globalMin, globalMax;
  if(allProgs.length){
    globalMin = new Date(Math.min(...allProgs.map(p => p.start.getTime())));
    globalMax = new Date(Math.max(...allProgs.map(p => p.stop.getTime())));
  } else {
    globalMin = new Date(now.getTime() - 3600000);
    globalMax = new Date(now.getTime() + 6*3600000);
  }
  tlGlobalMin = globalMin;
  tlGlobalMax = globalMax;

  if(!tlWindowStart || !tlWindowEnd){
    tlWindowStart = new Date(Math.max(globalMin.getTime(), now.getTime() - 3*3600000));
    tlWindowEnd = new Date(Math.min(globalMax.getTime(), now.getTime() + 21*3600000));
  }
  if(tlWindowStart < globalMin) tlWindowStart = new Date(globalMin);
  if(tlWindowEnd > globalMax) tlWindowEnd = new Date(globalMax);
  if(tlWindowStart > tlWindowEnd) tlWindowStart = new Date(tlWindowEnd);

  const dateInput = $('#tlDateInput');
  const toDateStr = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  dateInput.min = toDateStr(globalMin);
  dateInput.max = toDateStr(globalMax);
  if(!tlDateInited){
    dateInput.value = toDateStr(now >= globalMin && now <= globalMax ? now : globalMin);
    tlDateInited = true;
  }

  const totalMin = Math.max(60, (globalMax - globalMin) / 60000);
  const timelineWidth = totalMin * pxPerMin;

  let hourMarks = '';
  let hc = new Date(globalMin);
  hc.setMinutes(0, 0, 0);
  while(hc <= globalMax){
    if(hc >= globalMin){
      const x = (hc - globalMin) / 60000 * pxPerMin;
      const isMidnight = hc.getHours() === 0;
      const label = isMidnight
        ? hc.toLocaleDateString('fi-FI', { weekday:'short', day:'numeric', month:'numeric' })
        : fmtTime(hc);
      hourMarks += `<div class="tl-hour-mark ${isMidnight ? 'tl-day-mark' : ''}" style="left:${x}px">${label}</div>`;
    }
    hc = new Date(hc.getTime() + 3600000);
  }

  const nowX = (now - globalMin) / 60000 * pxPerMin;
  const nowInRange = now >= globalMin && now <= globalMax;
  const nowLineHtml = nowInRange ? `<div class="tl-now-line" style="left:${nowX}px"></div>` : '';

  tlBuildData = { globalMin, globalMax, timelineWidth, hourMarks, nowLineHtml, nowInRange, nowX };
  $('#tlHContent').style.width = timelineWidth + 'px';

  renderVisibleTimelineRows();
  updateHScrollbar();
}

function timelineRowHtml(r, now){
  if(r.type === 'header'){
    return {
      chcolHtml: `<div class="tl-group-header">${escapeHtml(r.category)}</div>`,
      trackHtml: `<div class="tl-group-header" style="width:${tlBuildData.timelineWidth}px"></div>`
    };
  }
  const ch = r.ch;
  const iconSrc = chIcon(ch);
  const num = chNumber(ch);
  const fav = isFavorite(ch);
  const iconInner = iconSrc
    ? `<img class="tl-icon" src="${escapeHtml(iconSrc)}" onerror="this.style.display='none'">`
    : `<div class="tl-ch-name">${escapeHtml(chDisplayName(ch))}</div>`;
  const chcolHtml = `<div class="tl-chcol-cell">
      <div class="icon-wrap">
        <div onclick="event.stopPropagation(); openChannelEdit('${ch.name.replace(/'/g,"\\'")}')">
          ${iconInner}
        </div>
        <div class="icon-footer">
          <div class="edit-pencil-btn" title="Muokkaa" onclick="event.stopPropagation(); openChannelEdit('${ch.name.replace(/'/g,"\\'")}')">
            <span class="msi">edit</span>
          </div>
          <div class="fav-star-btn ${fav ? 'active' : ''}" title="Suosikki" onclick="event.stopPropagation(); toggleFavorite('${ch.name.replace(/'/g,"\\'")}')">
            <span class="msi ${fav ? 'filled' : ''}">star</span>
          </div>
          ${num ? `<div class="ch-number-chip">${escapeHtml(num)}</div>` : ''}
        </div>
      </div>
    </div>`;

  const list = programmesByCh[ch.id] || [];
  const blocks = list.map((p, idx) => {
    if(p.stop < tlWindowStart || p.start > tlWindowEnd) return '';
    const x = (p.start - tlBuildData.globalMin) / 60000 * pxPerMin;
    const w = Math.max(34, (p.stop - p.start) / 60000 * pxPerMin - 3);
    const isCur = p.start <= now && now < p.stop;
    return `<div class="tl-block ${isCur ? 'current' : ''}" style="left:${x}px;width:${w}px"
              onclick="tlShowInfo('${ch.id.replace(/'/g,"\\'")}', ${idx})">
      <div class="tl-block-title">${escapeHtml(p.title)}</div>
      ${w > 90 ? `<div class="tl-block-desc">${escapeHtml(p.desc)}</div>` : ''}
      <div class="tl-block-time">${fmtTime(p.start)} - ${fmtTime(p.stop)}</div>
    </div>`;
  }).join('');
  const trackHtml = `<div class="tl-track" style="width:${tlBuildData.timelineWidth}px">${blocks}</div>`;

  return { chcolHtml, trackHtml };
}

// Raakatekstistä puuttumaan jäänyt sulku ja loppuosa renderöintilooppiin on korjattu täsmäämään koodia
function renderVisibleTimelineRows(){
  if(!tlBuildData) return;
  const now = new Date();
  const vscroll = $('#tlVScroll');
  const scrollTop = vscroll.scrollTop;
  const viewportH = vscroll.clientHeight || 600;
  const buffer = 6;
  const startIdx = Math.max(0, Math.floor(scrollTop / TL_ROW_HEIGHT) - buffer);
  const visibleCount = Math.ceil(viewportH / TL_ROW_HEIGHT) + buffer * 2;
  const endIdx = Math.min(tlRows.length, startIdx + visibleCount);

  const topH = startIdx * TL_ROW_HEIGHT;
  const bottomH = (tlRows.length - endIdx) * TL_ROW_HEIGHT;

  let chColInner = `<div class="tl-chcol-cell corner"></div><div style="height:${topH}px"></div>`;
  let hContentInner = `<div class="tl-hours-inner">${tlBuildData.hourMarks}${tlBuildData.nowLineHtml}</div><div style="height:${topH}px"></div>`;

  for(let i = startIdx; i < endIdx; i++){
    const row = tlRows[i];
    const { chcolHtml, trackHtml } = timelineRowHtml(row, now);
    chColInner += chcolHtml;
    hContentInner += trackHtml;
  }

  chColInner += `<div style="height:${bottomH}px"></div>`;
  hContentInner += `<div style="height:${bottomH}px"></div>`;

  $('#tlChCol').innerHTML = chColInner;
  $('#tlHContent').innerHTML = hContentInner;
}

$('#tlVScroll').addEventListener('scroll', renderVisibleTimelineRows);

// Loput apufunktiot (Skrollaukset, Zoomit ja Modaalit)
function updateHScrollbar(){
  const hs = $('#tlHScroll');
  const track = $('#tlSBTrack');
  const thumb = $('#tlSBThumb');
  if(!hs || !track || !thumb) return;
  const viewW = hs.clientWidth;
  const totalW = tlBuildData ? tlBuildData.timelineWidth : 1;
  const ratio = Math.min(1, viewW / totalW);
  thumb.style.width = Math.max(30, ratio * track.clientWidth) + 'px';
  const maxScroll = totalW - viewW;
  const pct = maxScroll > 0 ? hs.scrollLeft / maxScroll : 0;
  const maxThumb = track.clientWidth - thumb.clientWidth;
  thumb.style.left = (pct * maxThumb) + 'px';
}

$('#tlHScroll').addEventListener('scroll', updateHScrollbar);

function tlJumpNow(){
  if(!tlBuildData || !tlBuildData.nowInRange) return;
  const hs = $('#tlHScroll');
  const targetX = tlBuildData.nowX - hs.clientWidth / 3;
  hs.scrollLeft = Math.max(0, targetX);
  updateHScrollbar();
}

function tlPage(dir){
  const hs = $('#tlHScroll');
  hs.scrollLeft += dir * (3 * 60 * pxPerMin);
  updateHScrollbar();
}

function tlZoom(dir){
  const oldPx = pxPerMin;
  pxPerMin = Math.max(2, Math.min(24, pxPerMin + dir * 1.5));
  if(oldPx === pxPerMin) return;
  const hs = $('#tlHScroll');
  const centerTime = tlGlobalMin.getTime() + (hs.scrollLeft + hs.clientWidth / 2) / oldPx * 60000;
  renderTimeline();
  hs.scrollLeft = Math.max(0, (centerTime - tlGlobalMin.getTime()) / 60000 * pxPerMin - hs.clientWidth / 2);
  updateHScrollbar();
}

function tlJumpToDate(){
  const val = $('#tlDateInput').value;
  if(!val || !tlGlobalMin) return;
  const parts = val.split('-');
  const d = new Date(Date.UTC(+parts[0], +parts[1]-1, +parts[2], 6, 0, 0));
  const hs = $('#tlHScroll');
  const targetX = (d - tlGlobalMin) / 60000 * pxPerMin;
  hs.scrollLeft = Math.max(0, targetX);
  updateHScrollbar();
}

function tlShowInfo(chId, idx){
  const list = programmesByCh[chId] || [];
  const p = list[idx];
  if(!p) return;
  const ch = channels.find(c => c.id === chId);
  $('#tlSheet').innerHTML = `
    <button class="close" onclick="closeAllSheets()"><span class="msi">close</span></button>
    <h3>${escapeHtml(p.title)}</h3>
    <div class="meta">${ch ? escapeHtml(chDisplayName(ch)) : ''} · klo ${fmtTime(p.start)}–${fmtTime(p.stop)} ${p.category ? `· ${escapeHtml(p.category)}` : ''}</div>
    <div class="desc">${escapeHtml(p.desc || 'Ei tarkempia ohjelmatietoja.')}</div>
  `;
  $('#tlSheet').style.display = 'block';
  $('#tlBackdrop').style.display = 'block';
}

function showProgramSheetByTime(chId, startMs){
  const list = programmesByCh[chId] || [];
  const idx = list.findIndex(p => p.start.getTime() === startMs);
  if(idx !== -1) tlShowInfo(chId, idx);
}

function closeAllSheets(){
  $('#tlSheet').style.display = 'none';
  $('#chEditSheet').style.display = 'none';
  $('#tlBackdrop').style.display = 'none';
}

// Kellon ja päivämäärän päivitys yläpalkkiin
function updateHeaderClock(){
  const now = new Date();
  const options = { weekday: 'short', day: 'numeric', month: 'numeric' };
  $('#headerDate').textContent = now.toLocaleDateString('fi-FI', options);
  $('#clock').textContent = now.toLocaleTimeString('fi-FI', { hour12: false });
}
setInterval(updateHeaderClock, 1000);
updateHeaderClock();

let channels = [];      // {id, name, icon, xmlNumber}
let programmesByCh = {}; // id -> [{start:Date, stop:Date, title, desc, category}]
let expandedId = null;
let tallennettuXmlText = null; // ✅ Globaali muuttuja suurelle XML-datalle localStoragen sijaan
let customChannelMap = {}; // Kanavat.json tiedoston tiedot

const $ = s => document.querySelector(s);
const fileInput = $('#fileInput');
const dropzone = $('#dropzone');
const statusEl = $('#status');
const clearBtn = $('#clearBtn');

// ---------- Load kanavat.json metadata ----------
function loadChannelJsonMap(){
  return fetch('kanavat.json', { cache: 'no-store' })
    .then(res => res.ok ? res.json() : [])
    .then(data => {
      customChannelMap = {};
      if(Array.isArray(data)){
        data.forEach(item => {
          if(item.xmltv_id) customChannelMap[item.xmltv_id.trim().toLowerCase()] = item;
          if(item.nimi) customChannelMap[item.nimi.trim().toLowerCase()] = item;
          if(item.id) customChannelMap[item.id.trim().toLowerCase()] = item;
        });
      }
    })
    .catch(() => { customChannelMap = {}; });
}

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

function parseXmltv(xmlText){
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  const perr = doc.querySelector('parsererror');
  if(perr) throw new Error('XML ei kelpaa – tarkista tiedosto.');

  const chNodes = [...doc.getElementsByTagName('channel')];
  if(chNodes.length === 0) throw new Error('Tiedostosta ei löytynyt yhtään <channel>-elementtiä.');

  channels = chNodes.map(c => {
    const chIdAttr = c.getAttribute('id') || '';
    const dn = c.querySelector('display-name');
    const icon = c.querySelector('icon');
    const lcn = c.querySelector('lcn, number, channel-number');
    let xmlNumber = lcn ? lcn.textContent.trim() : '';
    const nameStr = dn ? dn.textContent.trim() : chIdAttr;
    
    if(!xmlNumber){
      const names = [...c.querySelectorAll('display-name')].map(n => n.textContent.trim());
      const numeric = names.find(n => /^\d{1,4}$/.test(n));
      if(numeric) xmlNumber = numeric;
    }

    // Yhdistetään kanavat.json logo/tiedot, jos löytyy xmltv_id:n tai nimen perusteella
    let mapped = customChannelMap[chIdAttr.toLowerCase()] || customChannelMap[nameStr.toLowerCase()];
    let finalIcon = mapped && mapped.logo ? mapped.logo : (icon ? icon.getAttribute('src') : null);

    return {
      id: chIdAttr,
      name: nameStr,
      icon: finalIcon,
      xmlNumber
    };
  });

  programmesByCh = {};
  const progNodes = [...doc.getElementsByTagName('programme')];
  for(const p of progNodes){
    const chId = p.getAttribute('channel');
    const start = parseXmltvTime(p.getAttribute('start'));
    const stop = parseXmltvTime(p.getAttribute('stop'));
    if(!chId || !start || !stop) continue;
    const titleEl = p.querySelector('title');
    const descEl = p.querySelector('desc');
    const catEl = p.querySelector('category');
    (programmesByCh[chId] ||= []).push({
      start, stop,
      title: titleEl ? titleEl.textContent.trim() : '(nimetön ohjelma)',
      desc: descEl ? descEl.textContent.trim() : '',
      category: catEl ? catEl.textContent.trim() : ''
    });
  }
  for(const id in programmesByCh){
    programmesByCh[id].sort((a,b) => a.start - b.start);
  }
}

// ---------- File loading & Persistent Status ----------
function loadText(text, label){
  try{
    parseXmltv(text);
    statusEl.className = '';
    statusEl.textContent = `Ladattu: ${label} · ${channels.length} kanavaa · ${Object.values(programmesByCh).reduce((a,b)=>a+b.length,0)} ohjelmaa`;
    clearBtn.style.display = 'inline-flex';
    
    tallennettuXmlText = text;
    try {
      localStorage.setItem('epg_portfolio_status_label', 'päivitetty');
    } catch(e) {
      console.warn("localStorage ongelma labelia tallennettaessa:", e);
    }
    render();
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
  return loadChannelJsonMap().then(() => {
    return fetch(url, { cache: 'no-store' })
      .then(res => {
        if(!res.ok) throw new Error('Palvelin vastasi: ' + res.status);
        return res.text();
      })
      .then(text => {
        loadText(text, name || url);
        localStorage.setItem('epg_active_url', url);
        localStorage.setItem('epg_last_fetch', String(Date.now()));
        if(silent){
          statusEl.className = '';
          statusEl.textContent = `Ladattu: ${name || url} · ${channels.length} kanavaa · ${Object.values(programmesByCh).reduce((a,b)=>a+b.length,0)} ohjelmaa (päivitetty automaattisesti)`;
        }
      })
      .catch(err => {
        if(silent) return;
        statusEl.className = 'err';
        statusEl.textContent = `Lähteen lataus epäonnistui: ${err.message}`;
      });
  });
}

function maybeAutoRefreshSource(){
  let activeUrl;
  try{ activeUrl = localStorage.getItem('epg_active_url'); }catch(e){ return; }
  const urlToFetch = activeUrl || "opas.xml";
  const labelToUse = activeUrl ? 'Automaattinen päivitys' : 'opas.xml';
  
  let lastFetch = 0;
  try{ lastFetch = parseInt(localStorage.getItem('epg_last_fetch') || '0', 10); }catch(e){}
  const hoursSince = (Date.now() - lastFetch) / 3600000;
  if(hoursSince >= 20 || !activeUrl){
    loadFromUrl(urlToFetch, labelToUse, true);
  }
}
setInterval(maybeAutoRefreshSource, 60 * 60 * 1000);

// ---------- Sources ----------
let sources = [];
try{ sources = JSON.parse(localStorage.getItem('epg_sources') || '[]'); }catch(e){ sources = []; }

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
        <button class="btn small" onclick="useSource(${i})">Käytä</button>
        <button class="btn small danger" onclick="removeSource(${i})">✕</button>
      </div>
    `).join('');
  }
}

function addSource(name, url){
  if(!url) return;
  if(!name) name = url.replace(/^https?:\/\//,'').split('/')[0];
  sources.push({ name, url });
  saveSources();
  renderSources();
}

function removeSource(i){
  sources.splice(i, 1);
  saveSources();
  renderSources();
}

function useSource(i){
  const s = sources[i];
  if(!s) return;
  loadFromUrl(s.url, s.name);
  closeSourcesModal();
}

function openSourcesModal(){
  renderSources();
  $('#sourcesModal').style.display = 'block';
  $('#sourcesBackdrop').style.display = 'block';
}
function closeSourcesModal(){
  $('#sourcesModal').style.display = 'none';
  $('#sourcesBackdrop').style.display = 'none';
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

// ---------- Settings ----------
function openSettingsModal(){
  $('#settingsStatus').textContent = '';
  updateNotifStatusText();
  $('#settingsModal').style.display = 'block';
  $('#settingsBackdrop').style.display = 'block';
}
function closeSettingsModal(){
  $('#settingsModal').style.display = 'none';
  $('#settingsBackdrop').style.display = 'none';
}

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
    channelMeta, sources, channelOrder,
    exportedAt: new Date().toISOString()
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'epg-live-asetukset.json';
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
      saveChannelMeta(); saveSources(); saveChannelOrder();
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
  channelMeta = {}; sources = []; channelOrder = [];
  try{
    localStorage.removeItem('epg_channel_meta');
    localStorage.removeItem('epg_sources');
    localStorage.removeItem('epg_channel_order');
    localStorage.removeItem('epg_portfolio_status_xml');
    localStorage.removeItem('epg_portfolio_status_label');
  }catch(e){}
  $('#settingsStatus').className = 'ch-url-status';
  $('#settingsStatus').textContent = 'Kaikki mukautukset nollattu.';
  render();
}

// ---------- Channel adjustments ----------
let channelMeta = {};
try{ channelMeta = JSON.parse(localStorage.getItem('epg_channel_meta') || '{}'); }catch(e){ channelMeta = {}; }

function chKey(name){ return (name || '').trim().toLowerCase(); }
function getMeta(name){ return channelMeta[chKey(name)] || {}; }
function saveChannelMeta(){
  try{ localStorage.setItem('epg_channel_meta', JSON.stringify(channelMeta)); return true; }
  catch(e){ return false; }
}
function chIcon(ch){ const m = getMeta(ch.name); return m.logo || ch.icon || null; }
function chNumber(ch){ const m = getMeta(ch.name); return (m.number || ch.xmlNumber || '').trim(); }
function channelMatchesQuery(ch, q){
  if(!q) return true;
  if(ch.name.toLowerCase().includes(q)) return true;
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

function allCategories(){
  const set = new Set();
  Object.values(channelMeta).forEach(m => { if(m.category) set.add(m.category); });
  return [...set].sort((a,b) => a.localeCompare(b,'fi'));
}

function groupByCategory(list){
  const groups = {};
  const order = [];
  list.forEach(ch => {
    const cat = getCategory(ch) || 'Muut';
    if(!groups[cat]){ groups[cat] = []; order.push(cat); }
    groups[cat].push(ch);
  });
  order.sort((a,b) => {
    if(a === 'Muut') return 1;
    if(b === 'Muut') return -1;
    return a.localeCompare(b, 'fi');
  });
  return order.map(cat => ({ category: cat, list: groups[cat] }));
}

let groupByCategoryEnabled = localStorage.getItem('epg_group_by_category') === '1';
$('#groupToggleBtn').classList.toggle('active', groupByCategoryEnabled);
function toggleGrouping(){
  groupByCategoryEnabled = !groupByCategoryEnabled;
  try{ localStorage.setItem('epg_group_by_category', groupByCategoryEnabled ? '1' : '0'); }catch(e){}
  $('#groupToggleBtn').classList.toggle('active', groupByCategoryEnabled);
  render();
}

function openHiddenModal(){
  const hidden = channels.filter(isHidden);
  $('#hiddenList').innerHTML = hidden.length === 0
    ? `<div class="src-empty">Ei piilotettuja kanavia.</div>`
    : hidden.map(ch => {
        const iconSrc = chIcon(ch);
        const iconHtml = iconSrc
          ? `<img class="order-icon-img" src="${escapeHtml(iconSrc)}">`
          : `<div class="order-icon-fallback">${escapeHtml(ch.name.slice(0,2).toUpperCase())}</div>`;
        return `<div class="src-item">
          ${iconHtml}
          <div class="src-info"><div class="src-name">${escapeHtml(ch.name)}</div></div>
          <button class="btn small" onclick="unhideChannel('${ch.name.replace(/'/g,"\\'")}')">👁 Näytä</button>
        </div>`;
      }).join('');
  $('#hiddenModal').style.display = 'block';
  $('#hiddenBackdrop').style.display = 'block';
}
function closeHiddenModal(){
  $('#hiddenModal').style.display = 'none';
  $('#hiddenBackdrop').style.display = 'none';
}
function unhideChannel(name){
  const key = chKey(name);
  if(channelMeta[key]) channelMeta[key].hidden = undefined;
  saveChannelMeta();
  openHiddenModal();
  render();
}

// ---------- Channel order ----------
let channelOrder = [];
try{ channelOrder = JSON.parse(localStorage.getItem('epg_channel_order') || '[]'); }catch(e){ channelOrder = []; }

function saveChannelOrder(){
  try{ localStorage.setItem('epg_channel_order', JSON.stringify(channelOrder)); }catch(e){}
}

function sortChannels(list){
  return list.slice().sort((a, b) => {
    const fa = isFavorite(a) ? 0 : 1;
    const fb = isFavorite(b) ? 0 : 1;
    if(fa !== fb) return fa - fb;
    const ia = channelOrder.indexOf(chKey(a.name));
    const ib = channelOrder.indexOf(chKey(b.name));
    if(ia === -1 && ib === -1) return a.name.localeCompare(b.name, 'fi');
    if(ia === -1) return 1;
    if(ib === -1) return -1;
    return ia - ib;
  });
}

function openOrderModal(){
  const known = channels.map(c => chKey(c.name));
  if(channelOrder.length === 0){
    channelOrder = channels.slice().sort((a,b) => a.name.localeCompare(b.name,'fi')).map(c => chKey(c.name));
  } else {
    known.forEach(k => { if(!channelOrder.includes(k)) channelOrder.push(k); });
    channelOrder = channelOrder.filter(k => known.includes(k));
  }
  renderOrderList();
  $('#orderModal').style.display = 'block';
  $('#orderBackdrop').style.display = 'block';
}

function renderOrderList(){
  $('#orderList').innerHTML = channelOrder.map((key) => {
    const ch = channels.find(c => chKey(c.name) === key);
    if(!ch) return '';
    const iconSrc = chIcon(ch);
    const iconHtml = iconSrc
      ? `<img class="order-icon-img" src="${escapeHtml(iconSrc)}">`
      : `<div class="order-icon-fallback">${escapeHtml(ch.name.slice(0,2).toUpperCase())}</div>`;
    return `<div class="src-item order-item" data-key="${escapeHtml(key)}">
      <div class="order-handle">⠿</div>
      ${iconHtml}
      <div class="src-info"><div class="src-name">${escapeHtml(ch.name)}</div></div>
      <button class="btn small" title="Ylimmäiseksi" onclick="moveChannelTop('${key.replace(/'/g,"\\'")}')">⤒</button>
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

function closeOrderModal(){
  $('#orderModal').style.display = 'none';
  $('#orderBackdrop').style.display = 'none';
}

// ---------- Drag operations (Pointer events) ----------
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
    <button class="close" onclick="closeChannelEdit()">✕</button>
    <h3>${escapeHtml(name)}</h3>
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
  const number = $('#chNumberInput').value.trim();
  const category = $('#chCategoryInput').value.trim();
  const hidden = $('#chHiddenInput').checked;
  const favorite = $('#chFavoriteInput').checked;
  const pendingLogo = $('#chEditPreview').dataset.pending;
  const existing = channelMeta[key] || {};
  channelMeta[key] = {
    number: number || undefined,
    category: category || undefined,
    hidden: hidden || undefined,
    favorite: favorite || undefined,
    logo: pendingLogo || existing.logo || undefined
  };
  const ok = saveChannelMeta();
  if(!ok){
    $('#chUrlStatus').className = 'ch-url-status err';
    $('#chUrlStatus').textContent = 'Tallennus epäonnistui – selaimen tallennustila on täynnä.';
    return;
  }
  closeChannelEdit();
  render();
}

function resetChannelMeta(){
  if(!editingChannel) return;
  delete channelMeta[chKey(editingChannel)];
  saveChannelMeta();
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
  reader.onload = ev => loadChannelJsonMap().then(() => loadText(ev.target.result, f.name));
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
  reader.onload = ev => loadChannelJsonMap().then(() => loadText(ev.target.result, f.name));
  reader.readAsText(f);
});

clearBtn.addEventListener('click', () => {
  channels = []; programmesByCh = {}; expandedId = null; tallennettuXmlText = null;
  try{
    localStorage.removeItem('epg_portfolio_status_xml');
    localStorage.removeItem('epg_portfolio_status_label');
    localStorage.removeItem('epg_active_url');
  }catch(e){}
  statusEl.textContent = ''; clearBtn.style.display = 'none';
  render();
});

(function restore(){
  try{
    let savedXml = localStorage.getItem('epg_portfolio_status_xml');
    if(savedXml) {
      loadChannelJsonMap().then(() => {
        loadText(savedXml, 'tallennettu opas');
        try { localStorage.removeItem('epg_portfolio_status_xml'); } catch(e){}
      });
    } else {
      loadFromUrl("opas.xml", "opas.xml", true);
    }
  }catch(e){
    console.error("Virhe tilan palautuksessa:", e);
  }
  setTimeout(maybeAutoRefreshSource, 4000);
})();

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
function escapeHtml(s){
  return (s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

let currentView = 'cards';
let pxPerMin = 6;
let tlGlobalMin = null;
let tlGlobalMax = null;
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
    main.appendChild(empty);
    $('#tlChCol').innerHTML = '';
    $('#tlHContent').innerHTML = '';
    return;
  }
  if(empty?.parentNode) empty.remove();

  if(currentView === 'cards') renderCards();
  else renderTimeline();
}

function renderCards(){
  const q = $('#search').value.trim().toLowerCase();
  const now = new Date();
  const main = $('#main');

  const filtered = sortChannels(channels.filter(c => !isHidden(c) && channelMatchesQuery(c, q)));

  if(groupByCategoryEnabled){
    main.innerHTML = groupByCategory(filtered).map(g => `
      <div class="category-header">${escapeHtml(g.category)}</div>
      ${g.list.map(ch => cardHtmlFor(ch, now)).join('')}
    `).join('');
  } else {
    main.innerHTML = filtered.map(ch => cardHtmlFor(ch, now)).join('');
  }
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
    : `<div class="ch-icon-name">${escapeHtml(ch.name)}</div>`;
  const iconHtml = `
    <div class="icon-wrap" onclick="event.stopPropagation(); openChannelEdit('${ch.name.replace(/'/g,"\\'")}')">
      ${iconInner}
      <div class="edit-pencil">✎</div>
      <div class="fav-star ${fav ? 'active' : ''}" title="Suosikki" onclick="event.stopPropagation(); toggleFavorite('${ch.name.replace(/'/g,"\\'")}')">${fav ? '★' : '☆'}</div>
      ${num ? `<div class="ch-number-badge">${escapeHtml(num)}</div>` : ''}
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

function renderTimeline(){
  const q = $('#search').value.trim().toLowerCase();
  const now = new Date();

  const filtered = sortChannels(channels.filter(c => !isHidden(c) && channelMatchesQuery(c, q)));

  let rows;
  if(groupByCategoryEnabled){
    rows = [];
    groupByCategory(filtered).forEach(g => {
      rows.push({ type: 'header', category: g.category });
      g.list.forEach(ch => rows.push({ type: 'channel', ch }));
    });
  } else {
    rows = filtered.map(ch => ({ type: 'channel', ch }));
  }

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

  const chColHtml = `<div class="tl-chcol-cell corner"></div>` + rows.map(r => {
    if(r.type === 'header') return `<div class="tl-group-header">${escapeHtml(r.category)}</div>`;
    const ch = r.ch;
    const iconSrc = chIcon(ch);
    const num = chNumber(ch);
    const fav = isFavorite(ch);
    const iconInner = iconSrc
      ? `<img class="tl-icon" src="${escapeHtml(iconSrc)}" onerror="this.style.display='none'">`
      : `<div class="tl-ch-name">${escapeHtml(ch.name)}</div>`;
    return `<div class="tl-chcol-cell">
      <div class="icon-wrap" onclick="event.stopPropagation(); openChannelEdit('${ch.name.replace(/'/g,"\\'")}')">
        ${iconInner}
        <div class="edit-pencil">✎</div>
        <div class="fav-star ${fav ? 'active' : ''}" title="Suosikki" onclick="event.stopPropagation(); toggleFavorite('${ch.name.replace(/'/g,"\\'")}')">${fav ? '★' : '☆'}</div>
        ${num ? `<div class="ch-number-badge">${escapeHtml(num)}</div>` : ''}
      </div>
    </div>`;
  }).join('');

  const tracksHtml = rows.map(r => {
    if(r.type === 'header') return `<div class="tl-group-header" style="width:${timelineWidth}px"></div>`;
    const ch = r.ch;
    const list = programmesByCh[ch.id] || [];
    const blocks = list.map((p, idx) => {
      const x = (p.start - globalMin) / 60000 * pxPerMin;
      const w = Math.max(34, (p.stop - p.start) / 60000 * pxPerMin - 3);
      const isCur = p.start <= now && now < p.stop;
      return `<div class="tl-block ${isCur ? 'current' : ''}" style="left:${x}px;width:${w}px"
                onclick="tlShowInfo('${ch.id.replace(/'/g,"\\'")}', ${idx})">
        <div class="tl-block-title">${escapeHtml(p.title)}</div>
        ${w > 90 ? `<div class="tl-block-desc">${escapeHtml(p.desc)}</div>` : ''}
        <div class="tl-block-time">${fmtTime(p.start)} - ${fmtTime(p.stop)}</div>
      </div>`;
    }).join('');
    return `<div class="tl-track" style="width:${timelineWidth}px">${blocks}</div>`;
  }).join('');

  $('#tlChCol').innerHTML = chColHtml;
  $('#tlHContent').style.width = timelineWidth + 'px';
  $('#tlHContent').innerHTML =
    `<div class="tl-hours-inner" style="width:${timelineWidth}px">${hourMarks}</div>` +
    tracksHtml + nowLineHtml;
  $('#tlHContent').dataset.nowx = nowInRange ? nowX : '';

  updateHScrollbar();
}

function updateHScrollbar(){
  const el = $('#tlHScroll');
  const track = $('#tlSBTrack');
  const thumb = $('#tlSBThumb');
  const trackWidth = track.clientWidth;
  const overflow = el.scrollWidth - el.clientWidth;
  if(overflow <= 2){
    $('#tlFooterRow').style.visibility = 'hidden';
    return;
  }
  $('#tlFooterRow').style.visibility = 'visible';
  const ratio = el.clientWidth / el.scrollWidth;
  const thumbWidth = Math.max(30, ratio * trackWidth);
  const maxThumbLeft = trackWidth - thumbWidth;
  const scrollRatio = el.scrollLeft / overflow;
  thumb.style.width = thumbWidth + 'px';
  thumb.style.left = (scrollRatio * maxThumbLeft) + 'px';
}

let sbDragging = false, sbStartX = 0, sbStartScrollLeft = 0;
$('#tlSBThumb').addEventListener('pointerdown', e => {
  sbDragging = true;
  sbStartX = e.clientX;
  sbStartScrollLeft = $('#tlHScroll').scrollLeft;
  $('#tlSBThumb').setPointerCapture(e.pointerId);
});
$('#tlSBThumb').addEventListener('pointermove', e => {
  if(!sbDragging) return;
  const el = $('#tlHScroll');
  const track = $('#tlSBTrack');
  const thumb = $('#tlSBThumb');
  const maxThumbLeft = track.clientWidth - thumb.offsetWidth;
  if(maxThumbLeft <= 0) return;
  const dx = e.clientX - sbStartX;
  const overflow = el.scrollWidth - el.clientWidth;
  el.scrollLeft = sbStartScrollLeft + (dx / maxThumbLeft) * overflow;
});
$('#tlSBThumb').addEventListener('pointerup', () => { sbDragging = false; });
$('#tlSBTrack').addEventListener('pointerdown', e => {
  if(e.target !== $('#tlSBTrack')) return;
  const track = $('#tlSBTrack');
  const thumb = $('#tlSBThumb');
  const el = $('#tlHScroll');
  const rect = track.getBoundingClientRect();
  const clickX = e.clientX - rect.left - thumb.offsetWidth / 2;
  const maxThumbLeft = track.clientWidth - thumb.offsetWidth;
  const ratio = Math.min(1, Math.max(0, clickX / maxThumbLeft));
  el.scrollLeft = ratio * (el.scrollWidth - el.clientWidth);
});
window.addEventListener('resize', () => { if(currentView === 'timeline') updateHScrollbar(); });

$('#tlHScroll').addEventListener('scroll', () => { updateHScrollbar(); });

function tlPage(dir){
  $('#tlHScroll').scrollBy({ left: dir * 3 * 60 * pxPerMin, behavior: 'smooth' });
}

function tlZoom(dir){
  const el = $('#tlHScroll');
  const oldPx = pxPerMin;
  pxPerMin = Math.min(14, Math.max(2, pxPerMin + dir * 2));
  const minutesAtLeft = el.scrollLeft / oldPx;
  renderTimeline();
  el.scrollLeft = Math.max(0, minutesAtLeft * pxPerMin);
  updateHScrollbar();
}

function tlJumpNow(){
  renderTimeline();
  const el = $('#tlHScroll');
  const nowx = parseFloat($('#tlHContent').dataset.nowx);
  if(!isNaN(nowx)) el.scrollLeft = Math.max(0, nowx - 60);
  updateHScrollbar();
}

function tlJumpToDate(){
  const val = $('#tlDateInput').value;
  if(!val || !tlGlobalMin) return;
  const [y, m, d] = val.split('-').map(Number);
  const target = new Date(y, m - 1, d, 0, 0, 0);
  const x = Math.max(0, (target - tlGlobalMin) / 60000 * pxPerMin);
  $('#tlHScroll').scrollLeft = x;
  updateHScrollbar();
}

function showProgramSheet(ch, p){
  if(!ch || !p) return;
  const now = new Date();
  const isCur = p.start <= now && now < p.stop;
  $('#tlSheet').innerHTML = `
    <button class="close" onclick="tlCloseSheet()">✕</button>
    <div class="meta">${escapeHtml(ch.name)} ${isCur ? '· <span style="color:var(--live)">LIVE NYT</span>' : ''}</div>
    <h3>${escapeHtml(p.title)}</h3>
    <div class="meta">${fmtTime(p.start)}–${fmtTime(p.stop)}${p.category ? ' · ' + escapeHtml(p.category) : ''}</div>
    <div class="desc">${escapeHtml(p.desc) || 'Ei kuvausta saatavilla.'}</div>
  `;
  $('#tlSheet').style.display = 'block';
  $('#tlBackdrop').style.display = 'block';
}

function showProgramSheetByTime(chId, startMs){
  const ch = channels.find(c => c.id === chId);
  const p = (programmesByCh[chId] || []).find(pr => pr.start.getTime() === startMs);
  showProgramSheet(ch, p);
}

function tlShowInfo(chId, idx){
  const ch = channels.find(c => c.id === chId);
  const p = (programmesByCh[chId] || [])[idx];
  showProgramSheet(ch, p);
}

function tlCloseSheet(){
  $('#tlSheet').style.display = 'none';
  $('#tlBackdrop').style.display = 'none';
}

function closeAllSheets(){
  tlCloseSheet();
  closeChannelEdit();
}

function tickClock(){
  $('#clock').textContent = new Date().toLocaleTimeString('fi-FI');
}
setInterval(tickClock, 1000);
tickClock();

setInterval(render, 15000);

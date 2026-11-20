'use strict';
const $ = (s, r = document) => r.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};
const toast = (m) => { const t = h('div', { class: 'toast', text: m }); document.body.append(t); setTimeout(() => t.remove(), 2600); };
const fmtTime = (s) => { s = Math.max(0, Math.round(s || 0)); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return (hh ? hh + ':' + String(mm).padStart(2, '0') : mm) + ':' + String(ss).padStart(2, '0'); };
const fmtSize = (b) => (b > 1e9 ? (b / 1e9).toFixed(2) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.round(b / 1e3) + ' KB');
const parseTime = (s) => { s = String(s || '').trim(); if (!s) return 0; const p = s.split(':').map(Number); if (p.some((x) => isNaN(x) || x < 0)) return NaN; return p.reduce((a, x) => a * 60 + x, 0); };

// ---------- formats ----------
const FORMATS = {
  mp4:  { label: 'MP4 video (H.264)', ext: 'mp4', kind: 'video' },
  mkv:  { label: 'MKV video (H.264)', ext: 'mkv', kind: 'video' },
  mov:  { label: 'MOV video (H.264)', ext: 'mov', kind: 'video' },
  webm: { label: 'WebM video (VP9)', ext: 'webm', kind: 'video' },
  dvd:  { label: 'DVD video (MPEG-2, .mpg)', ext: 'mpg', kind: 'video', dvd: true },
  cvid: { label: 'Compress video (to target size)', ext: 'mp4', kind: 'video', compress: true },
  caud: { label: 'Compress audio (small MP3)', ext: 'mp3', kind: 'audio', compress: true },
  gif:  { label: 'Animated GIF', ext: 'gif', kind: 'gif' },
  mp3:  { label: 'MP3 audio', ext: 'mp3', kind: 'audio' },
  m4a:  { label: 'AAC audio (M4A)', ext: 'm4a', kind: 'audio' },
  wav:  { label: 'WAV audio', ext: 'wav', kind: 'audio' },
  flac: { label: 'FLAC audio', ext: 'flac', kind: 'audio' },
  opus: { label: 'Opus audio', ext: 'opus', kind: 'audio' },
};
const opt = { fmt: 'mp4', quality: '24', height: '0', fps: '0', abr: '160', noAudio: false, start: '', end: '', targetMb: '', hw: 'cpu', dvdStd: 'pal' };
const HW = { nvenc: ['h264_nvenc', 'NVIDIA (NVENC)'], qsv: ['h264_qsv', 'Intel (Quick Sync)'], amf: ['h264_amf', 'AMD (AMF)'] };
let queue = []; // {id, fid, name, size, dur, w, h, hasVideo, status, pct, outName, err}
let outFolder = null; // {id, name}
let running = false, cancelRequested = false;

// ---------- UI ----------
const app = $('#app');
const toolbar = h('div', { class: 'toolbar' });
const main = h('div', { class: 'main', style: 'flex:1;min-height:0;min-width:0;width:100%;overflow:hidden' });
const stage = h('div', { class: 'stage', style: 'padding:0;flex:1;min-width:0;overflow:auto' });
const right = h('div', { class: 'sidebar right', style: 'width:300px' });
const status = h('div', { class: 'status' });
main.append(stage, right); app.append(toolbar, main, status);
const btn = (label, fn, cls = '') => h('button', { class: 'btn ' + cls, onclick: fn, text: label });
const bRun = btn('Convert all', runAll, 'primary'), bCancel = btn('Stop', () => { cancelRequested = true; window.host.cancel(); });
toolbar.append(btn('Add files', addFiles), btn('Output folder', pickFolder), h('span', { class: 'sep' }), bRun, bCancel, h('span', { class: 'sep' }), btn('Remove selected', removeSel), btn('Clear finished', clearDone), h('span', { class: 'grow' }), h('span', { id: 'folderLbl', class: 'muted' }));
let selected = new Set();

function render() {
  stage.textContent = '';
  if (!queue.length) {
    stage.append(h('div', { style: 'padding:40px;text-align:center;color:var(--text-2)' }, h('div', { style: 'font-size:15px;margin-bottom:10px;color:var(--text)', text: 'Add video or audio files to convert' }), btn('Add files', addFiles, 'primary')));
  } else {
    const t = h('table', { class: 'grid', style: 'width:100%' }, h('thead', {}, h('tr', {}, ...['File', 'Details', 'Size', 'Result', 'Status'].map((c) => h('th', { text: c })))));
    const tb = h('tbody');
    for (const q of queue) {
      const tr = h('tr', { class: selected.has(q.id) ? 'sel' : '', onclick: (e) => { if (e.ctrlKey || e.shiftKey) { selected.has(q.id) ? selected.delete(q.id) : selected.add(q.id); } else selected = new Set([q.id]); render(); } });
      const det = q.err && q.status === 'failed' ? '' : [q.hasVideo ? q.w + 'x' + q.h : 'Audio', fmtTime(q.dur)].join('  -  ');
      const stat = q.status === 'running' ? h('div', { class: 'progress', style: 'min-width:120px' }, h('div', { style: `width:${q.pct}%` })) : h('span', { text: ({ waiting: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Stopped' })[q.status] || q.status, title: q.err || '' });
      tr.append(h('td', { text: q.name, style: 'max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }), h('td', { text: det }), h('td', { text: fmtSize(q.size) }),
        h('td', {}, q.status === 'done' ? h('span', {}, q.outName + ' (' + fmtSize(q.outSize) + ') ', btn('Show', (e) => { e.stopPropagation(); window.host.reveal(q.outId); })) : (q.status === 'failed' ? h('span', { class: 'muted', title: q.err, text: (q.err || '').split('\n').pop().slice(0, 60) }) : '')), h('td', {}, stat));
      tb.append(tr);
    }
    t.append(tb); stage.append(t);
  }
  renderRight(); renderStatus();
}
function renderStatus() {
  status.textContent = '';
  const done = queue.filter((q) => q.status === 'done').length;
  status.append(h('span', { text: queue.length + ' files' }), h('span', { text: done + ' done' }), h('span', { class: 'grow' }), h('span', { text: running ? 'Converting...' : 'Ready' }));
  bRun.disabled = running || !queue.length; bCancel.disabled = !running;
  $('#folderLbl').textContent = outFolder ? 'Saving to: ' + outFolder.name : 'No output folder chosen';
}
function sel(label, key, options, onchange) {
  const s = h('select', { style: 'width:100%', onchange: (e) => { opt[key] = e.target.value; if (onchange) onchange(); else renderRight(); } }, ...options.map(([v, t]) => h('option', { value: v, text: t, selected: opt[key] === v })));
  return h('label', { class: 'field' }, label, s);
}
function renderRight() {
  right.textContent = '';
  const f = FORMATS[opt.fmt], isV = f.kind === 'video', isG = f.kind === 'gif', isA = f.kind === 'audio';
  right.append(h('h3', { text: 'Convert to' }), sel('Format', 'fmt', Object.entries(FORMATS).map(([k, v]) => [k, v.label]), () => { fixDefaults(); renderRight(); }));
  if (isV) {
    if (f.dvd) right.append(sel('DVD standard', 'dvdStd', [['pal', 'PAL (25 fps, 720x576)'], ['ntsc', 'NTSC (29.97 fps, 720x480)']]), h('div', { class: 'muted', style: 'font-size:12px', text: 'Creates a DVD-compliant .mpg. Use any disc authoring tool to burn it; Shiftout does not write discs.' }));
    else {
    if (f.compress) right.append(h('div', { class: 'muted', style: 'font-size:12px', text: 'Set a target size below. The video bitrate is calculated so the result lands just under it.' }));
    right.append(sel('Quality', 'quality', [['20', 'High'], ['24', 'Balanced'], ['28', 'Small file'], ['32', 'Smallest']]),
      sel('Resolution', 'height', [['0', 'Keep original'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p']]),
      sel('Frame rate', 'fps', [['0', 'Keep original'], ['60', '60 fps'], ['30', '30 fps'], ['24', '24 fps'], ['15', '15 fps']]));
    if (opt.fmt !== 'webm') right.append(sel('Encoder', 'hw', [['cpu', 'CPU (x264)'], ...Object.entries(HW).map(([k, v]) => [k, v[1] + ' - GPU'])]), h('div', { class: 'muted', style: 'font-size:12px', text: 'GPU encoding is faster. If your graphics card cannot do it, Shiftout retries on the CPU automatically.' }));
    }
    if (!f.dvd) right.append(h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: opt.noAudio, onchange: (e) => { opt.noAudio = e.target.checked; renderRight(); } }), 'Remove audio'));
    if (!opt.noAudio && !FORMATS[opt.fmt].dvd) right.append(sel('Audio quality', 'abr', [['96', '96 kbps'], ['128', '128 kbps'], ['160', '160 kbps'], ['192', '192 kbps'], ['256', '256 kbps']]));
    if (!f.dvd) right.append(h('label', { class: 'field' }, f.compress ? 'Target size in MB' : 'Target size in MB (optional)', h('input', { type: 'number', min: 1, value: opt.targetMb, placeholder: 'Use quality setting', oninput: (e) => { opt.targetMb = e.target.value; } })));
  }
  if (isG) right.append(sel('Width', 'height', [['480', '480 px'], ['360', '360 px'], ['720', '720 px'], ['240', '240 px']]), sel('Frame rate', 'fps', [['12', '12 fps'], ['10', '10 fps'], ['15', '15 fps'], ['20', '20 fps']]));
  if (isA && !f.compress && opt.fmt !== 'wav' && opt.fmt !== 'flac') right.append(sel('Bitrate', 'abr', [['128', '128 kbps'], ['160', '160 kbps'], ['192', '192 kbps'], ['256', '256 kbps'], ['320', '320 kbps']]));
  right.append(h('h3', { text: 'Trim (optional)' }), h('div', { class: 'row' },
    h('label', { class: 'field' }, 'Start', h('input', { type: 'text', value: opt.start, placeholder: '0:00', style: 'width:100%', oninput: (e) => { opt.start = e.target.value; } })),
    h('label', { class: 'field' }, 'End', h('input', { type: 'text', value: opt.end, placeholder: 'end', style: 'width:100%', oninput: (e) => { opt.end = e.target.value; } }))));
  right.append(h('div', { class: 'muted', style: 'font-size:12px;margin-top:8px', text: 'Everything happens on this computer. Your files are never uploaded.' }));
}
// default sensible values when switching format kinds
function fixDefaults() { const k = FORMATS[opt.fmt].kind; if (k === 'gif') { if (!['480', '360', '720', '240'].includes(opt.height)) opt.height = '480'; if (!['12', '10', '15', '20'].includes(opt.fps)) opt.fps = '12'; } else if (k === 'video') { if (['240'].includes(opt.height)) opt.height = '0'; if (opt.fps === '12' || opt.fps === '10' || opt.fps === '20') opt.fps = '0'; } }
const origSel = sel;

// ---------- queue ----------
const MEDIA_FILTERS = [['Media files', ['mp4', 'mkv', 'mov', 'avi', 'webm', 'wmv', 'flv', 'm4v', 'mpg', 'mpeg', 'ts', '3gp', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'gif']], ['All files', ['*']]];
async function addFiles() {
  const files = await window.host.openFiles({ multi: true, read: false, filters: MEDIA_FILTERS });
  for (const f of files) {
    const q = { id: Math.random().toString(36).slice(2, 8), fid: f.id, name: f.name, size: f.size, dur: 0, w: 0, h: 0, hasVideo: false, status: 'waiting', pct: 0 };
    const p = await window.host.probe(f.id);
    if (!p.json || !p.json.streams) { toast(f.name + ' is not a readable media file'); continue; }
    q.dur = parseFloat(p.json.format.duration) || 0;
    const v = p.json.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    if (v) { q.hasVideo = true; q.w = v.width; q.h = v.height; }
    queue.push(q);
  }
  render();
}
async function pickFolder() { const f = await window.host.chooseFolder(); if (f) { outFolder = f; renderStatus(); } }
function removeSel() { if (running) return; queue = queue.filter((q) => !selected.has(q.id)); selected.clear(); render(); }
function clearDone() { if (running) return; queue = queue.filter((q) => q.status !== 'done'); render(); }

function buildArgs(q) {
  const f = FORMATS[opt.fmt]; const a = []; const start = parseTime(opt.start), end = parseTime(opt.end);
  if (isNaN(start) || isNaN(end)) throw new Error('Trim times must look like 1:30 or 90');
  const total = Math.max(0, (end || q.dur) - start);
  if (end && end <= start) throw new Error('End must be after start');
  if (start) a.push('-ss', String(start));
  a.push('-i', '{in0}');
  if (end || start) { if (end) a.push('-t', String(+(end - start).toFixed(3))); }
  const dur = total || q.dur || 1;
  if (f.kind === 'audio') {
    a.push('-vn');
    if (opt.fmt === 'caud') a.push('-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k');
    else if (opt.fmt === 'mp3') a.push('-c:a', 'libmp3lame', '-b:a', opt.abr + 'k');
    else if (opt.fmt === 'm4a') a.push('-c:a', 'aac', '-b:a', opt.abr + 'k');
    else if (opt.fmt === 'opus') a.push('-c:a', 'libopus', '-b:a', opt.abr + 'k');
    else if (opt.fmt === 'wav') a.push('-c:a', 'pcm_s16le');
    else if (opt.fmt === 'flac') a.push('-c:a', 'flac');
  } else if (f.kind === 'gif') {
    if (!q.hasVideo) throw new Error('This file has no video to turn into a GIF');
    a.push('-vf', `fps=${opt.fps},scale=${opt.height}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`, '-loop', '0');
  } else {
    if (!q.hasVideo) throw new Error('This file has no video. Pick an audio format instead');
    if (f.dvd) { a.push('-target', opt.dvdStd === 'ntsc' ? 'ntsc-dvd' : 'pal-dvd'); a.push('{out}'); return { args: a, dur }; }
    if (f.compress && !(parseFloat(opt.targetMb) > 0)) throw new Error('Enter a target size in MB');
    const vf = []; if (opt.height !== '0') vf.push(`scale=-2:${opt.height}`);
    if (vf.length) a.push('-vf', vf.join(','));
    if (opt.fps !== '0') a.push('-r', opt.fps);
    const tgt = parseFloat(opt.targetMb);
    const abr = opt.noAudio ? 0 : +opt.abr;
    let vrate = null;
    if (tgt > 0) { vrate = Math.floor((tgt * 8192 * 0.96) / dur - abr); if (vrate < 60) throw new Error('Target size is too small for this length'); }
    if (opt.fmt === 'webm') { a.push('-c:v', 'libvpx-vp9', '-row-mt', '1', '-cpu-used', '4'); if (vrate) a.push('-b:v', vrate + 'k'); else a.push('-crf', String(+opt.quality + 6), '-b:v', '0'); }
    else {
      const hwk = opt.hw !== 'cpu' && !opt.forceCpu ? HW[opt.hw] : null;
      if (hwk) { a.push('-c:v', hwk[0]); if (opt.hw === 'nvenc') a.push('-preset', 'p4'); a.push('-pix_fmt', 'yuv420p'); if (vrate) a.push('-b:v', vrate + 'k', '-maxrate', Math.round(vrate * 1.4) + 'k', '-bufsize', vrate * 2 + 'k'); else if (opt.hw === 'nvenc') a.push('-rc', 'vbr', '-cq', opt.quality, '-b:v', '0'); else if (opt.hw === 'qsv') a.push('-global_quality', opt.quality); else a.push('-rc', 'cqp', '-qp_i', opt.quality, '-qp_p', opt.quality); }
      else { a.push('-c:v', 'libx264', '-preset', 'medium', '-pix_fmt', 'yuv420p'); if (vrate) a.push('-b:v', vrate + 'k', '-maxrate', Math.round(vrate * 1.4) + 'k', '-bufsize', vrate * 2 + 'k'); else a.push('-crf', opt.quality); }
    }
    if (opt.noAudio) a.push('-an'); else if (opt.fmt === 'webm') a.push('-c:a', 'libopus', '-b:a', abr + 'k'); else a.push('-c:a', 'aac', '-b:a', abr + 'k');
    if (opt.fmt === 'mp4' || opt.fmt === 'mov' || opt.fmt === 'cvid') a.push('-movflags', '+faststart');
  }
  a.push('{out}');
  return { args: a, dur };
}
async function runAll() {
  fixDefaults();
  if (running || !queue.length) return;
  if (!outFolder) { await pickFolder(); if (!outFolder) return; }
  running = true; cancelRequested = false; renderStatus();
  for (const q of queue) {
    if (q.status === 'done') continue;
    if (cancelRequested) { q.status = 'cancelled'; continue; }
    q.status = 'running'; q.pct = 0; q.err = ''; render();
    try {
      let { args, dur } = buildArgs(q);
      window.host.onProgress((p) => { q.pct = Math.min(99, Math.round((p.t / dur) * 100)); const bar = stage.querySelector('tr.sel .progress div, .progress div'); updateBars(); });
      const base = q.name.replace(/\.[^.]+$/, '');
      const job = () => window.host.run({ args, inputs: [q.fid], out: { dir: outFolder.id, name: base + '.' + FORMATS[opt.fmt].ext }, duration: dur });
      let r;
      try { r = await job(); } catch (e1) {
        if (opt.hw === 'cpu' || FORMATS[opt.fmt].kind !== 'video' || cancelRequested || /Cancelled/.test(String(e1))) throw e1;
        opt.forceCpu = true; try { ({ args, dur } = buildArgs(q)); } finally { opt.forceCpu = false; }
        toast('GPU encoder unavailable, using the CPU'); r = await job();
      }
      q.status = 'done'; q.outId = r.id; q.outName = r.name; q.outSize = r.size; q.pct = 100;
    } catch (e) { q.status = /Cancelled/.test(String(e)) || cancelRequested ? 'cancelled' : 'failed'; q.err = String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /, ''); }
    render();
  }
  running = false; renderStatus(); render();
  const ok = queue.filter((q) => q.status === 'done').length; toast(ok + ' of ' + queue.length + ' converted');
}
function updateBars() { const rows = [...stage.querySelectorAll('tbody tr')]; queue.forEach((q, i) => { if (q.status === 'running') { const b = rows[i] && rows[i].querySelector('.progress div'); if (b) b.style.width = q.pct + '%'; } }); }

render();

const { app, BrowserWindow, dialog, ipcMain, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const { Readable } = require('stream');

const MIME = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.bmp':'image/bmp','.mp4':'video/mp4','.m4v':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.mkv':'video/x-matroska','.mp3':'audio/mpeg','.wav':'audio/wav','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.opus':'audio/ogg','.flac':'audio/flac'};
const mimeFor = p => MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
const kindFor = m => m.startsWith('image/') ? 'image' : m.startsWith('video/') ? 'video' : m.startsWith('audio/') ? 'audio' : 'other';
const IMAGE_EXT = ['jpg','jpeg','png','webp','gif','bmp'];
const VIDEO_EXT = ['mp4','m4v','webm','mov','mkv'];
const AUDIO_EXT = ['mp3','wav','m4a','aac','ogg','opus','flac'];
const mediaUrl = p => `ammedia://file/${Buffer.from(p, 'utf8').toString('base64url')}`;

protocol.registerSchemesAsPrivileged([{scheme:'ammedia',privileges:{standard:true,secure:true,stream:true,supportFetchAPI:true,bypassCSP:true}}]);

async function scenesFromZip(buffer) {
  const zip = await JSZip.loadAsync(buffer), scenes = [];
  for (const file of Object.values(zip.files)) {
    if (file.dir || !/\.xml$/i.test(file.name)) continue;
    const text = await file.async('string');
    if (/^\s*(?:<\?xml[^>]*>\s*)?<scene[\s>]/i.test(text)) scenes.push({name:path.basename(file.name), text});
  }
  return scenes;
}
function meta(html, key) { const m=html.match(new RegExp(`<meta\\s+[^>]*property=["']${key}["'][^>]*content=["']([^"']*)["']`,'i')); return m?.[1]||''; }
const SHARE_RE=/^https?:\/\/(?:www\.)?(?:alight\.link|alight\.page\.link|alightcreative\.com|www\.alightmotion\.com)\//i;
const CANONICAL_RE=/\/am\/share\/u\/([^/]+)\/p\/([^/?#]+)/i;
async function sharePage(url) {
  if(!SHARE_RE.test(url)) throw Error('URL bukan link Alight Motion yang didukung');
  const r=await fetch(url,{redirect:'follow',headers:{'user-agent':'AM-XML-Player/0.2'}}); if(!r.ok) throw Error(`Share page gagal (${r.status})`);
  const finalUrl=r.url, html=await r.text(), c=finalUrl.match(CANONICAL_RE); if(!c) throw Error('Link tidak mengarah ke halaman share AM');
  const desc=meta(html,'og:description'); return {finalUrl,metadata:{url:finalUrl,ownerId:c[1],packageId:c[2],title:meta(html,'og:title')||'Alight Motion package',thumbnail:meta(html,'og:image'),description:desc,projectCount:Number((desc.match(/contains (\d+) project/i)||[])[1]||0)}};
}
function createWindow(){const win=new BrowserWindow({width:1440,height:900,minWidth:1000,minHeight:650,backgroundColor:'#090c14',webPreferences:{contextIsolation:true,nodeIntegration:false,preload:path.join(__dirname,'preload.js')}});win.loadFile(path.join(__dirname,'index.html'));}
app.whenReady().then(()=>{
  protocol.handle('ammedia', request=>{try{const encoded=new URL(request.url).pathname.slice(1),filePath=Buffer.from(encoded,'base64url').toString('utf8');if(!fs.existsSync(filePath))return new Response('Not found',{status:404});return new Response(Readable.toWeb(fs.createReadStream(filePath)),{headers:{'content-type':mimeFor(filePath),'cache-control':'no-cache'}})}catch{return new Response('Bad media URL',{status:400})}});
  ipcMain.handle('open-file',async()=>{const r=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'AM project',extensions:['xml','alight','zip']} ]});return r.canceled?null:r.filePaths[0]});
  ipcMain.handle('read-file',async(_,p)=>{const b=fs.readFileSync(p);if(/\.(alight|zip)$/i.test(p)){const scenes=await scenesFromZip(b);if(!scenes.length)throw Error('Paket tidak berisi scene XML');return {scenes}}return {scenes:[{name:path.basename(p),text:b.toString('utf8')}]}});
  ipcMain.handle('open-media',async()=>{const r=await dialog.showOpenDialog({properties:['openFile','multiSelections'],filters:[{name:'Media',extensions:[...IMAGE_EXT,...VIDEO_EXT,...AUDIO_EXT]}]});return r.canceled?[]:r.filePaths.map(p=>({path:p,name:path.basename(p),mime:mimeFor(p),kind:kindFor(mimeFor(p)),url:mediaUrl(p),size:fs.statSync(p).size}))});
  ipcMain.handle('resolve-share',async(_,url)=>{const p=await sharePage(url),resolver=process.env.AM_SHARE_RESOLVER_URL;if(!resolver)return {metadata:p.metadata,requiresResolver:true};const r=await fetch(`${resolver.replace(/\/$/,'')}?url=${encodeURIComponent(p.finalUrl)}`,{headers:{accept:'application/json,application/zip,application/octet-stream'}});if(!r.ok)throw Error(`Resolver gagal (${r.status})`);if((r.headers.get('content-type')||'').includes('json')){const x=await r.json();if(x.scenes)return {metadata:p.metadata,scenes:x.scenes};if(x.xml)return {metadata:p.metadata,scenes:[{name:'share.xml',text:x.xml}]};throw Error('Response resolver tidak punya scenes/xml')}const scenes=await scenesFromZip(Buffer.from(await r.arrayBuffer()));if(!scenes.length)throw Error('Package tidak berisi scene XML');return {metadata:p.metadata,scenes}});
  createWindow();app.on('activate',()=>{if(!BrowserWindow.getAllWindows().length)createWindow()});
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit()});

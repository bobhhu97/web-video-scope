import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
const DIST = resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript' };
const server = createServer(async (q, s) => {
  try { const p = join(DIST, decodeURIComponent(new URL(q.url,'http://x').pathname));
    const body = await readFile(p);
    s.writeHead(200,{'content-type':MIME[extname(p)]??'application/octet-stream'}); s.end(body);
  } catch { if(!s.headersSent) s.writeHead(404).end(); }
});
await new Promise(k=>server.listen(4180,'127.0.0.1',k));
const b = await puppeteer.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,
  args:['--enable-unsafe-webgpu','--enable-features=Vulkan,WebGPU','--use-angle=metal','--no-sandbox']});
const p = await b.newPage();
await p.setViewport({width:1500,height:900});
p.on('console',m=>{ if(m.type()!=='log') console.log(`[${m.type()}]`,m.text().slice(0,200)); });
await p.goto('http://127.0.0.1:4180/test-harness.html?range=limited&mode=vectorscope&pattern=bars',{waitUntil:'networkidle2'});
await p.waitForFunction(()=>/fps|ERROR/.test(document.getElementById('status')?.textContent??''),{timeout:20000});
await new Promise(r=>setTimeout(r,1200));

const out = await p.evaluate(async () => {
  const log=[];
  const {renderer} = window.__scope;
  log.push(`renderer: ${renderer.options.width}x${renderer.options.height} mode=${renderer.options.mode} zoom=${renderer.options.zoom}`);

  const canvas=document.getElementById('scope-gpu');
  await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
  const bmp=await createImageBitmap(canvas);
  const oc=new OffscreenCanvas(bmp.width,bmp.height);
  const c=oc.getContext('2d'); c.drawImage(bmp,0,0);
  const d=c.getImageData(0,0,bmp.width,bmp.height).data;
  // histogram of luminance
  const buckets={};
  let lit=0;
  const pts=[];
  for(let y=0;y<bmp.height;y++) for(let x=0;x<bmp.width;x++){
    const i=(y*bmp.width+x)*4;
    const l=d[i]+d[i+1]+d[i+2];
    if(l>40){lit++; if(pts.length<20) pts.push({x,y,r:d[i],g:d[i+1],b:d[i+2],a:d[i+3]});}
  }
  log.push(`canvas ${bmp.width}x${bmp.height} lit=${lit}`);
  log.push('first lit points: '+JSON.stringify(pts));
  // Check density via the shader's own histogram readback
  const hist = await renderer.render(window.__scope.downscaler, true);
  log.push('histSum='+(hist?Array.from(hist).reduce((a,b2)=>a+b2,0):'null'));
  const nz=[]; if(hist){ for(let i=0;i<hist.length;i++) if(hist[i]) nz.push([i,hist[i]]); }
  log.push('nonzero bins='+nz.length+' '+JSON.stringify(nz.slice(0,8)));
  return {log};
});
console.log(out.log.join('\n'));
await b.close(); await new Promise(k=>server.close(k));

/** Headless Edge, isolated profile/database. Never opens or changes a user's recording tab. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { createServer, request as proxyRequest } from 'node:http';
import { mkdir, mkdtemp, readFile, open } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
const {values}=parseArgs({options:{binary:{type:'string'},edge:{type:'string',default:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'}}});
if(!values.binary)throw Error('--binary <server.exe> required');
await mkdir('.tools/phase2-validation',{recursive:true});const runtime=await mkdtemp(resolve('.tools/phase2-validation/browser-'));
const binary=resolve(values.binary),password=randomBytes(24).toString('hex'),origin='http://127.0.0.1:18783';
const args=['--data-dir',runtime,'--listen','127.0.0.1:18782','--origin',origin,'--insecure-local'];
const log=await open(join(runtime,'server.log'),'a');
async function run(command,args,env){const child=spawn(command,args,{env,windowsHide:true,stdio:['ignore',log.fd,log.fd]});return new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)});}
assert.equal(await run(binary,[...args,'--init-admin'],{...process.env,QQSG_ADMIN_PASSWORD:password}),0);
const server=spawn(binary,args,{windowsHide:true,stdio:['ignore',log.fd,log.fd]});
const root=resolve('dist');
const web=createServer(async(req,res)=>{
 if(req.url.startsWith('/fighting/api/')){const proxy=proxyRequest({hostname:'127.0.0.1',port:18782,path:req.url,method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res)});proxy.on('error',()=>{res.writeHead(502);res.end()});req.pipe(proxy);return;}
 try{let route=decodeURIComponent(new URL(req.url,origin).pathname);if(!route.startsWith('/fighting/')){res.writeHead(404);res.end();return;}route=route.slice('/fighting/'.length);if(!route||route.endsWith('/'))route+='index.html';const file=resolve(root,route);if(!file.startsWith(root+'/')&&!file.startsWith(root+'\\'))throw Error('path');const body=await readFile(file);res.writeHead(200,{'Content-Type':({'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'})[extname(file)]??'application/octet-stream','Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'});res.end(body);}catch{res.writeHead(404);res.end();}
});
let browser;
try{
 for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:18782/fighting/api/v1/admin/session')).status===401)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 await new Promise((r,j)=>{web.once('error',j);web.listen(18783,'127.0.0.1',r)});
 browser=await chromium.launchPersistentContext(join(runtime,'edge-profile'),{executablePath:values.edge,headless:true,timeout:20000,args:['--disable-gpu','--disable-crash-reporter'],viewport:{width:1440,height:1000},acceptDownloads:true});
 const page=await browser.newPage(),errors=[],apiCalls=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().includes('/api/'))apiCalls.push(r.url())});
 await page.goto(origin+'/fighting/');await page.locator('#record').waitFor();assert.equal(await page.locator('#record').isDisabled(),true);assert.equal(await page.locator('#sync-enabled').isChecked(),false);await page.waitForTimeout(2500);assert.equal(apiCalls.length,0,'unconfigured public capture page must not connect to backend');assert.equal(await page.locator('a[href*="admin"]').count(),0);
 await page.screenshot({path:join(runtime,'capture.png'),fullPage:true});
 await page.goto(origin+'/fighting/admin/');await page.locator('#login-form').waitFor();await page.locator('#password').fill(password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'名单与采集接入',exact:true}).waitFor();
 await page.getByRole('button',{name:'名单与采集接入',exact:true}).click();await page.locator('#config-nameA').waitFor();await page.locator('#config-nameA').fill('测试甲');await page.locator('#config-nameB').fill('测试乙');await page.locator('#save-config').click();await page.waitForFunction(()=>document.querySelector('#admin-status')?.textContent.includes('名单已保存'));
 await page.locator('#collector-label').fill('browser-smoke');await page.locator('#create-credential').click();await page.waitForFunction(()=>document.querySelector('#credential-result')?.textContent.includes('token'));const credential=JSON.parse(await page.locator('#credential-result').textContent());
 const at=Math.floor(Date.now()/1000)*1000,sessionId='browser-session';
 async function send(id,delta){const time=new Date(at+delta+8*3600000).toISOString().slice(11,19);const response=await fetch('http://127.0.0.1:18782/fighting/api/v1/ingest/batches',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential.token},body:JSON.stringify({schemaVersion:2,batchId:randomBytes(12).toString('hex'),sourceId:credential.sourceId,sessionId,context:{sessionStartedAtMs:at,realm:'browser-test',line:'1',clockOffsetMs:0,clockUncertaintyMs:0},messages:[{id,sessionId,revision:1,text:'[地图]测试甲在战斗中击败了测试乙',gameTime:time,firstObservedAtMs:at+delta,lastObservedAtMs:at+delta,observations:1}]})});assert.equal(response.status,200);}
 await send('first',-2000);await page.getByRole('button',{name:'击杀战报',exact:true}).click();await page.locator('tbody').getByText('测试乙',{exact:true}).first().waitFor();
 const reason=page.getByPlaceholder('更正原因',{exact:true});await reason.fill('正在输入的备注');await send('second',-1000);await page.waitForFunction(()=>document.querySelector('#admin-status')?.textContent.includes('正在保护你的编辑'),{},{timeout:10000});assert.equal(await reason.inputValue(),'正在输入的备注');
 await page.getByRole('button',{name:'战报统计',exact:true}).click();await page.getByRole('heading',{name:'K/D（无助攻数据）',exact:true}).waitFor();await page.screenshot({path:join(runtime,'admin-stats.png'),fullPage:true});
 const downloadPromise=page.waitForEvent('download');await page.locator('#excel').click();const download=await downloadPromise;await download.saveAs(join(runtime,'browser-report.xlsx'));assert.equal(await download.failure(),null);
 await page.locator('#logout').click();await page.locator('#login-form').waitFor();assert.equal(errors.length,0,errors.join('\n'));
 console.log(JSON.stringify({mode:'headless-edge-smoke',passed:true,checks:['public-capture-no-upload','private-login','name-config','source-credential','live-events','editing-preserved','statistics','excel-download','logout'],runtimeDirectory:runtime}));
}finally{await browser?.close();await new Promise(r=>web.close(r));server.kill();await new Promise(r=>server.once('close',r));await log.close();}

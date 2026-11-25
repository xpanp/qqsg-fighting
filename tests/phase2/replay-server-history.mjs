/** Invoked by isolated harness; imports no real data into the source repository. */
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {parseArgs} from 'node:util';
import assert from 'node:assert/strict';
import {inflateRawSync} from 'node:zlib';
import {parseLegacyAliases} from './history.mjs';
const {values}=parseArgs({options:{input:{type:'string'}}});
if(!values.input)throw Error('--input <historical run directory> required');
const base=process.env.QQSG_TEST_SERVER,password=process.env.QQSG_TEST_ADMIN_PASSWORD;
if(!base||!password)throw Error('Isolated test environment missing');
const origin=new URL(base).origin;if(!['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))throw Error('History validation requires loopback');
let cookie='',csrf='';
async function call(path,body){const r=await fetch(new URL('/fighting/api/v1/'+path,base),{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});if(!r.ok)throw Error(`HTTP ${r.status} for ${path.split('?')[0]}`);if(path==='admin/login')cookie=r.headers.get('set-cookie')?.split(';')[0]??'';return r.json();}
csrf=(await call('admin/login',{username:'admin',password})).csrfToken;
const configDir=join(values.input,'config_snapshot');
async function lines(file){return(await readFile(join(configDir,file),'utf8')).replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#'));}
// Legacy snapshots allow repeated names within one faction and use alias TAB canonical.
// Adapt their file contract, without editing source files or changing wire semantics.
const nameA=[...new Set(await lines('name_xiao.txt'))],nameB=[...new Set(await lines('name_zhige.txt'))],nameOthers=[...new Set(await lines('name_others.txt'))];
const aliases=parseLegacyAliases(await readFile(join(configDir,'name_aliases.tsv'),'utf8'));
const config={nameA,nameB,nameOthers,aliases,blacklist:await lines('death_blacklist.txt')};
console.log(JSON.stringify({mode:'real-history-config',counts:{A:nameA.length,B:nameB.length,others:nameOthers.length,aliases:aliases.length,blacklist:config.blacklist.length}}));
await call('admin/name-configs',config);
async function replay(input,source,token){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['tests/phase2/replay-history.mjs','--input',input,'--server',base,'--source',source,'--realm','historical-validation','--line','1'],{env:{...process.env,QQSG_REPLAY_TOKEN:token},stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(Error('History upload failed')));});}
const start=Date.parse('2026-11-21T00:00:00+08:00'),end=Date.parse('2026-11-22T00:00:00+08:00');
let jobs=[];
async function settle(){const {jobId}=await call('admin/reprocess',{});for(let n=0;n<600;n++){jobs=(await call('admin/jobs')).jobs;const j=jobs.find(j=>j.id===jobId);if(j?.status==='failed')throw Error('History processing job failed');if(j?.status==='done')return;await new Promise(r=>setTimeout(r,200));}throw Error('Full history projection did not finish within two minutes');}
async function snapshot(){const stats=await call(`admin/stats?start=${start}&end=${end}`),events=await call(`admin/events?start=${start}&end=${end}&limit=1`);return{events:events.total,a:stats.overview.aKills,b:stats.overview.bKills,kills:stats.kills,deaths:stats.deaths};}
for(const label of ['primary','external']){
 const c=await call('admin/collector-credentials',{label:'real-history-'+label}),input=join(values.input,'sources',label,'messages.txt');
 await replay(input,c.sourceId,c.token);await settle();const before=await snapshot();
 await replay(input,c.sourceId,c.token);await settle();const after=await snapshot();assert.deepEqual(after,before,`${label}: replaying identical input cannot increase events or statistics`);
 console.log(JSON.stringify({mode:'history-idempotency',source:label,events:after.events,aKills:after.a,bKills:after.b,passed:true}));
}
const stats=await call(`admin/stats?start=${start}&end=${end}`),events=await call(`admin/events?start=${start}&end=${end}&limit=1`);
assert.equal(stats.kills.reduce((n,r)=>n+r.count,0),stats.overview.aKills+stats.overview.bKills);
assert.equal(stats.deaths.reduce((n,r)=>n+r.count,0),stats.overview.aKills+stats.overview.bKills);
const blocked=new Set(config.blacklist);for(const rows of [stats.kills,stats.deaths,stats.kda])for(const row of rows){assert.ok(['A','B'].includes(row.faction),'Others cannot enter A/B statistics');assert.ok(!blocked.has(row.name),'Blacklisted standard name cannot enter statistics');}
const exported=await fetch(new URL('/fighting/api/v1/admin/exports',base),{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf},body:JSON.stringify({start,end,projectionVersion:stats.projectionVersion}),signal:AbortSignal.timeout(30000)});assert.equal(exported.status,200);
const zip=Buffer.from(await exported.arrayBuffer());
function unzipEntry(name){for(let pos=0;pos<zip.length-46;pos++){if(zip.readUInt32LE(pos)!==0x02014b50)continue;const len=zip.readUInt16LE(pos+28),extra=zip.readUInt16LE(pos+30),comment=zip.readUInt16LE(pos+32),filename=zip.subarray(pos+46,pos+46+len).toString();if(filename===name){const size=zip.readUInt32LE(pos+20),local=zip.readUInt32LE(pos+42),method=zip.readUInt16LE(pos+10),begin=local+30+zip.readUInt16LE(local+26)+zip.readUInt16LE(local+28),data=zip.subarray(begin,begin+size);return(method===8?inflateRawSync(data):data).toString();}pos+=45+len+extra+comment;}throw Error('Missing XLSX entry: '+name);}
const sheet=unzipEntry('xl/worksheets/sheet1.xml');
function cell(address){const [,column,row]=address.match(/^([A-Z]+)(\d+)$/),r=sheet.match(new RegExp('<row[^>]*r="'+row+'"[^>]*>([\\s\\S]*?)</row>'));assert.ok(r,'Missing exported overview row '+row);const cells=[...r[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)],index=[...column].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)-1,m=cells[index];assert.ok(m,'Missing exported overview cell '+address);return m[1].match(/<(?:v|t)(?: [^>]*)?>([^<]*)<\/(?:v|t)>/)?.[1];}
assert.equal(Number(cell('C2')),stats.overview.aKills);assert.equal(Number(cell('D2')),stats.overview.bKills);
for(const n of ['击杀','死亡','KD','阵营优势','事件数据'])assert.ok(unzipEntry('xl/workbook.xml').includes(n),'Missing export dimension '+n);
console.log(JSON.stringify({mode:'real-history-result',events:events.total,projectionVersion:stats.projectionVersion,overview:stats.overview,killRows:stats.kills.length,deathRows:stats.deaths.length,kdRows:stats.kda.length,jobCount:jobs.length},null,2));

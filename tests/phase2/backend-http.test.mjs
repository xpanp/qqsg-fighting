import test,{before} from 'node:test';
import assert from 'node:assert/strict';
const base=process.env.QQSG_TEST_SERVER;
const password=process.env.QQSG_TEST_ADMIN_PASSWORD;
let cookie='',csrf='',source,token;
const prefix='/fighting/api/v1/';
const origin=base?new URL(base).origin:'';
const gameTime=ms=>new Date(ms+8*3600000).toISOString().slice(11,19);
async function request(path,{method='GET',body,admin=false,bearer,csrfToken=csrf}={}){
 const headers={'Content-Type':'application/json',Origin:origin};
 if(admin){headers.Cookie=cookie;if(method!=='GET')headers['X-CSRF-Token']=csrfToken;}
 if(bearer)headers.Authorization='Bearer '+bearer;
 return fetch(new URL(prefix+path,base),{method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
}
before(async()=>{
 if(!base)return;
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname),'HTTP integration tests require isolated loopback server');
 assert.ok(password,'QQSG_TEST_ADMIN_PASSWORD required');
 const r=await request('admin/login',{method:'POST',body:{username:'admin',password}});
 assert.equal(r.status,200);cookie=r.headers.get('set-cookie')?.split(';')[0]??'';csrf=(await r.json()).csrfToken;assert.ok(cookie&&csrf);
});
const options={skip:!base};
test('all private read endpoints reject anonymous requests',options,async()=>{
 for(const p of ['admin/session','admin/events','admin/stats','admin/name-configs','admin/jobs','admin/collector-credentials','admin/stream']){
  const r=await request(p);assert.equal(r.status,401,p);
 }
});
test('admin writes require valid CSRF and create a restricted source',options,async()=>{
 const denied=await request('admin/collector-credentials',{method:'POST',admin:true,csrfToken:'invalid',body:{label:'denied'}});assert.equal(denied.status,403);
 const r=await request('admin/collector-credentials',{method:'POST',admin:true,body:{label:'isolated-http-test'}});assert.equal(r.status,200);
 const b=await r.json();source=b.sourceId;token=b.token;assert.ok(source&&token);
});
test('collector credential only permits ingest and time, never admin data',options,async()=>{
 const time=await request('time',{bearer:token});assert.equal(time.status,200);assert.ok(Number.isFinite((await time.json()).serverTimeMs));
 for(const p of ['admin/events','admin/stats','admin/stream']){const r=await request(p,{bearer:token});assert.equal(r.status,401,p);}
});
test('collector source spoofing is rejected before receipt',options,async()=>{
 const r=await request('ingest/batches',{method:'POST',bearer:token,body:{schemaVersion:2,batchId:'spoof',sourceId:'not-owned',sessionId:'spoof',context:{sessionStartedAtMs:Date.now(),realm:'test',line:'1'},messages:[]}});
 assert.ok([400,403].includes(r.status));
});
test('same-source replay is idempotent; delayed older revision does not replace newer',options,async()=>{
 const at=Date.now(),sessionId='http-test-session';
 const original={id:'event-one',sessionId,revision:1,text:'[地图]测试甲在战斗中击败了测试乙',firstObservedAtMs:at,lastObservedAtMs:at,observations:1};
 const payload={schemaVersion:2,batchId:'idempotent-batch',sourceId:source,sessionId,context:{sessionStartedAtMs:at,realm:'test',line:'1',clockOffsetMs:0,clockUncertaintyMs:0},messages:[original]};
 for(let i=0;i<2;i++){const r=await request('ingest/batches',{method:'POST',bearer:token,body:payload});assert.equal(r.status,200);const b=await r.json();assert.equal(b.accepted.length,1);assert.equal(b.rejected.length,0);}
 const revised={...original,revision:2,text:'[地图]测试甲在战斗中击败了测试丙'};
 for(const m of [revised,original]){const r=await request('ingest/batches',{method:'POST',bearer:token,body:{...payload,batchId:crypto.randomUUID(),messages:[m]}});assert.equal(r.status,200);}
 let events=[];for(let n=0;n<50;n++){const r=await request(`admin/events?start=${at}&end=${at+1}`,{admin:true});assert.equal(r.status,200);events=(await r.json()).events;if(events.length===1&&events[0].victim==='测试丙')break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(events.length,1);assert.equal(events[0].victim,'测试丙','Older revision cannot replace latest projection');
});
test('authenticated SSE returns snapshot and is cancellable',options,async()=>{
 const r=await request('admin/stream',{admin:true});assert.equal(r.status,200);assert.match(r.headers.get('content-type')??'',/text\/event-stream/);
 const reader=r.body.getReader();try{const first=await reader.read();assert.equal(first.done,false);assert.match(new TextDecoder().decode(first.value),/event:\s*update/);}finally{await reader.cancel();}
});
test('admin Excel export is an actual XLSX archive',options,async()=>{
 const r=await request('admin/exports',{method:'POST',admin:true,body:{}});assert.equal(r.status,200);
 assert.match(r.headers.get('content-type')??'',/spreadsheetml/);
 const b=new Uint8Array(await r.arrayBuffer());assert.equal(String.fromCharCode(...b.slice(0,2)),'PK');
});
test('cross-source matching preserves a second distinct same-source occurrence',options,async()=>{
 const config=await request('admin/name-configs',{method:'POST',admin:true,body:{nameA:['测试甲'],nameB:['测试乙','测试丙'],nameOthers:[],aliases:[],blacklist:[]}});assert.equal(config.status,200);
 const other=await request('admin/collector-credentials',{method:'POST',admin:true,body:{label:'second-http-test'}});assert.equal(other.status,200);const second=await other.json();
 const at=Math.floor((Date.now()-60000)/1000)*1000,sessionId='cross-source-session';
 async function send(sourceId,bearer,id,delta){const message={id,sessionId,revision:1,text:'[地图]测试甲在战斗中击败了测试乙',gameTime:gameTime(at+(id==='second'?1000:0)),firstObservedAtMs:at+delta,lastObservedAtMs:at+delta,observations:1};const r=await request('ingest/batches',{method:'POST',bearer,body:{schemaVersion:2,batchId:crypto.randomUUID(),sourceId,sessionId,context:{sessionStartedAtMs:at,realm:'cross-test',line:'1',clockOffsetMs:0,clockUncertaintyMs:0},messages:[message]}});assert.equal(r.status,200);}
 await send(source,token,'first',0);await send(second.sourceId,second.token,'first',500);await send(source,token,'second',1000);
 let events=[];
 for(let n=0;n<50;n++){const r=await request(`admin/events?start=${at}&end=${at+1500}`,{admin:true});assert.equal(r.status,200);events=(await r.json()).events;if(events.length===2)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(events.length,2,'Different message occurrences from one source cannot collapse via a third-source evidence match');
 assert.equal(events.filter(e=>e.sourceCount===2).length,1);assert.equal(events.filter(e=>e.sourceCount===1).length,1);
 const stats=await request(`admin/stats?start=${at}&end=${at+1500}`,{admin:true});assert.equal(stats.status,200);const s=await stats.json();assert.equal(s.overview.aKills,2);assert.equal(s.overview.bKills,0);
 const invalid=await request('admin/name-configs',{method:'POST',admin:true,body:{nameA:['测试甲'],nameB:['测试甲'],nameOthers:[],aliases:[],blacklist:[]}});assert.equal(invalid.status,400,'Cross-faction conflicting standard names are rejected');
 const block=await request('admin/name-configs',{method:'POST',admin:true,body:{nameA:['测试甲'],nameB:['测试乙','测试丙'],nameOthers:[],aliases:[],blacklist:['测试乙']}});assert.equal(block.status,200);
 let blocked;for(let n=0;n<50;n++){const r=await request(`admin/stats?start=${at}&end=${at+1500}`,{admin:true});assert.equal(r.status,200);blocked=await r.json();if(blocked.overview.aKills===0)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(blocked.overview.aKills,0,'Blacklisted victim removes entire event from all A/B statistics');
});
test('revoking a source credential blocks further uploads',options,async()=>{
 const revoke=await request('admin/collector-credentials',{method:'POST',admin:true,body:{sourceId:source,revoke:true}});assert.equal(revoke.status,200);
 assert.ok([401,403].includes((await request('time',{bearer:token})).status));
});
test('manual correction survives a newly arriving earlier third source without duplicating events',options,async()=>{
 const conf=await request('admin/name-configs',{method:'POST',admin:true,body:{nameA:['测试甲'],nameB:['测试乙','测试丙'],nameOthers:[],aliases:[],blacklist:[]}});assert.equal(conf.status,200);
 const credentials=[];for(let i=0;i<3;i++){const r=await request('admin/collector-credentials',{method:'POST',admin:true,body:{sourceId:'correction-'+['z','y','a'][i]+'-'+crypto.randomUUID(),label:'correction-source-'+i}});assert.equal(r.status,200);credentials.push(await r.json());}
 const at=Math.floor((Date.now()-120000)/1000)*1000,sessionId='correction-session';
 async function send(index,delta){const c=credentials[index],r=await request('ingest/batches',{method:'POST',bearer:c.token,body:{schemaVersion:2,batchId:crypto.randomUUID(),sourceId:c.sourceId,sessionId,context:{sessionStartedAtMs:at,realm:'correction-test',line:'1',clockOffsetMs:0,clockUncertaintyMs:0},messages:[{id:'message',sessionId,revision:1,text:'[地图]测试甲在战斗中击败了测试乙',gameTime:gameTime(at),firstObservedAtMs:at+delta,lastObservedAtMs:at+delta,observations:1}]}});assert.equal(r.status,200);}
 async function wait(check){let events=[];for(let n=0;n<50;n++){const r=await request(`admin/events?start=${at-1000}&end=${at+2000}`,{admin:true});assert.equal(r.status,200);events=(await r.json()).events;if(check(events))return events;await new Promise(r=>setTimeout(r,100));}return events;}
 await send(0,0);await send(1,500);let events=await wait(e=>e.length===1&&e[0].sourceCount===2);assert.equal(events.length,1);assert.equal(events[0].sourceCount,2);const id=events[0].id;
 const corrected=await request('admin/event-overrides',{method:'POST',admin:true,body:{requestId:crypto.randomUUID(),eventId:id,killer:'测试丙',reason:'independent integration correction'}});assert.equal(corrected.status,200);
 events=await wait(e=>e.length===1&&e[0].killer==='测试丙');assert.equal(events.length,1);assert.equal(events[0].killer,'测试丙','Correcting one canonical event must not split its evidence');
 await send(2,-500);events=await wait(e=>e.length===1&&e[0].sourceCount===3);assert.equal(events.length,1);assert.equal(events[0].sourceCount,3);assert.equal(events[0].id,id,'Newly arriving earlier evidence must not change canonical ID');assert.equal(events[0].killer,'测试丙');
});
test('observation clock proximity alone never merges two sources without game time',options,async()=>{
 const at=Date.now()-180000,sessionId='observation-only-session';
 for(let i=0;i<2;i++){
  const r=await request('admin/collector-credentials',{method:'POST',admin:true,body:{label:'observation-only-'+i}});assert.equal(r.status,200);const c=await r.json();
  const ingest=await request('ingest/batches',{method:'POST',bearer:c.token,body:{schemaVersion:2,batchId:crypto.randomUUID(),sourceId:c.sourceId,sessionId,context:{sessionStartedAtMs:at,realm:'observation-only',line:'1',clockOffsetMs:0,clockUncertaintyMs:0},messages:[{id:'first',sessionId,revision:1,text:'[地图]测试甲在战斗中击败了测试乙',firstObservedAtMs:at+i*100,lastObservedAtMs:at+i*100,observations:1}]}});assert.equal(ingest.status,200);
 }
 let events=[];for(let n=0;n<50;n++){const r=await request(`admin/events?start=${at}&end=${at+1000}`,{admin:true});assert.equal(r.status,200);events=(await r.json()).events;if(events.length===2)break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(events.length,2);assert.ok(events.every(e=>e.sourceCount===1),'Observed-only evidence remains separate and reviewable');
});

test('incremental result and two full rebuilds preserve identities, overrides, and statistics',options,async()=>{
 const rangeStart=Date.now()-86400000,rangeEnd=Date.now()+3600000;
 async function snapshot(){
  const r=await request(`admin/events?limit=500&start=${rangeStart}&end=${rangeEnd}`,{admin:true});assert.equal(r.status,200);const body=await r.json();
  const normalized=body.events.map(e=>({id:e.id,occurredAtMs:e.occurredAtMs,killer:e.killer,victim:e.victim,killerFaction:e.killerFaction,victimFaction:e.victimFaction,status:e.status,reason:e.reason,sourceCount:e.sourceCount,sourceIds:[...e.sourceIds].sort(),configVersion:e.configVersion,timeQuality:e.timeQuality,algorithmVersion:e.algorithmVersion})).sort((a,b)=>a.id.localeCompare(b.id));
  const sr=await request(`admin/stats?start=${rangeStart}&end=${rangeEnd}`,{admin:true});assert.equal(sr.status,200);const{projectionVersion,...stats}=await sr.json();return{events:normalized,stats};
 }
 const initial=await snapshot();
 for(let attempt=0;attempt<2;attempt++){
  const r=await request('admin/reprocess',{method:'POST',admin:true,body:{}});assert.equal(r.status,200);const{jobId}=await r.json();let done=false;
  for(let n=0;n<100;n++){const j=await request('admin/jobs',{admin:true});assert.equal(j.status,200);const job=(await j.json()).jobs.find(x=>x.id===jobId);assert.notEqual(job?.status,'failed');if(job?.status==='done'){done=true;break;}await new Promise(r=>setTimeout(r,100));}
  assert.ok(done,'Explicit full rebuild must finish');assert.deepEqual(await snapshot(),initial,'Full rebuild cannot change prior incremental identities, manual decisions, or totals');
 }
});
test('real permanent rejection JSON includes retryable false and integer UTC wire timestamps work',options,async()=>{
 const created=await request('admin/collector-credentials',{method:'POST',admin:true,body:{label:'wire-contract'}});assert.equal(created.status,200);const credential=await created.json();
 const at=Date.now(),sessionId='wire-contract-session';const message={id:'wire',sessionId,revision:1,text:'[地图]测试甲在战斗中击败了测试乙',firstObservedAtMs:at,lastObservedAtMs:at,observations:1};
 const payload={schemaVersion:2,batchId:'wire-contract',sourceId:credential.sourceId,sessionId,context:{sessionStartedAtMs:at,realm:'contract',line:'1',clockOffsetMs:0,clockUncertaintyMs:0},messages:[message]};
 let response=await request('ingest/batches',{method:'POST',bearer:credential.token,body:payload});assert.equal(response.status,200);assert.equal((await response.json()).accepted.length,1);
 response=await request('ingest/batches',{method:'POST',bearer:credential.token,body:{...payload,messages:[{...message,text:'[地图]测试乙在战斗中击败了测试甲'}]}});assert.equal(response.status,200);const rejected=(await response.json()).rejected[0];assert.equal(rejected.code,'revision_conflict');assert.equal(rejected.retryable,false);assert.ok(Object.hasOwn(rejected,'retryable'),'False must not be omitted from the Go response');
 response=await request('ingest/batches',{method:'POST',bearer:credential.token,body:{...payload,messages:[{...message,firstObservedAtMs:at+0.25}]}});assert.equal(response.status,400,'Wire contract is integer UTC ms; capture mapper has an independent fractional-time regression');
});

import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Outbox} from '../../frontend/src/sync/outbox.ts';
import {SyncClient, type SyncSettings} from '../../frontend/src/sync/client.ts';
import type {MergedMessage} from '../../contracts/types.ts';
import {DurableRecorder} from '../../frontend/src/capture/recorder.ts';

const message=(id='one',revision=1,sessionId='session'):MergedMessage=>({id,revision,sessionId,text:'[地图][14:00:00]甲在战斗中击败了乙',firstObservedAtMs:Date.now(),lastObservedAtMs:Date.now(),observations:1,gameTime:'14:00:00'});
const grant={sessionId:'session',sourceId:'source',context:{sessionStartedAtMs:Date.now(),realm:'test-realm',line:'1'}};
async function fixture(options:{limit?:number;scan?:()=>Promise<{rows:MergedMessage[];after?:string}>;fetch?:typeof fetch}={}){
 const outbox=new Outbox(options.limit??5000,'sync-test-'+crypto.randomUUID());await outbox.authorize(grant);
 let settings:SyncSettings={enabled:true,token:'private-test-token',sourceId:'source',realm:'test-realm',line:'1'};
 const requests:{url:string,body?:any,token:string|null}[]=[],statuses:any[]=[];
 const fetcher:typeof fetch=options.fetch??(async(url,init)=>{
  const body=init?.body?JSON.parse(String(init.body)):undefined;requests.push({url:String(url),body,token:new Headers(init?.headers).get('Authorization')});
  return Response.json(String(url).endsWith('/time')?{serverTimeMs:Date.now()}:{batchId:body.batchId,accepted:body.messages.map((m:any)=>({id:m.id,revision:m.revision,sessionId:body.sessionId})),rejected:[]});
 });
 const client=new SyncClient({settings:()=>settings,onStatus:s=>statuses.push(s),scan:options.scan??(async()=>({rows:[]})),outbox,fetch:fetcher});
 return{client,outbox,requests,statuses,setSettings:(s:Partial<SyncSettings>)=>{settings={...settings,...s};}};
}
test('acknowledged revision stays acknowledged across a fresh outbox instance',async()=>{
 const f=await fixture();await f.outbox.enqueue(grant,message());await f.client.tick();assert.equal((await f.outbox.rows()).length,0);
 const reopened=new Outbox(5000,f.outbox.name);await reopened.enqueue(grant,message());assert.equal((await reopened.rows()).length,0);
});
test('old acknowledgement cannot remove a newer revision arriving during request',async()=>{
 let f:Awaited<ReturnType<typeof fixture>>;f=await fixture({fetch:async(url,init)=>{
  if(String(url).endsWith('/time'))return Response.json({serverTimeMs:Date.now()});
  const body=JSON.parse(String(init?.body));await f.outbox.enqueue(grant,message('one',2));
  return Response.json({batchId:body.batchId,accepted:[{id:'one',sessionId:'session',revision:1}],rejected:[]});
 }});await f.outbox.enqueue(grant,message());await f.client.tick();assert.equal((await f.outbox.rows())[0].message.revision,2);
});
for(const status of [500,401])test(`HTTP ${status} preserves pending data and notify remains nonblocking`,async()=>{
 let calls=0;const f=await fixture({fetch:async()=>{calls++;return new Response('',{status});}});
 assert.equal(f.client.notify([message()]),undefined);await f.outbox.enqueue(grant,message());await f.client.tick();assert.equal((await f.outbox.rows()).length,1);
 await f.client.tick();assert.equal(calls,status===401?1:2);assert.ok(f.statuses.some(s=>s.detail.includes('录像继续')));
});
test('offline rejection retains data and disabled sync performs no network calls',async()=>{
 let calls=0;const f=await fixture({fetch:async()=>{calls++;throw Error('offline');}});await f.outbox.enqueue(grant,message());await f.client.tick();assert.equal((await f.outbox.rows()).length,1);
 f.setSettings({enabled:false});await f.client.tick();assert.equal(calls,1);
});
test('full outbox does not deadlock sending queued rows before scan repair',async()=>{
 const f=await fixture({limit:1,scan:async()=>({rows:[message('new')]})});await f.outbox.enqueue(grant,message('old'));
 await f.client.tick();await f.client.tick();assert.equal(f.requests.filter(r=>r.body).length,2);assert.equal((await f.outbox.rows()).length,0);
});
test('malformed or wrong-batch ack never drops a pending message',async()=>{
 const f=await fixture({fetch:async(url)=>Response.json(String(url).endsWith('/time')?{serverTimeMs:Date.now()}:{batchId:'other',accepted:[],rejected:[]})});
 await f.outbox.enqueue(grant,message());await f.client.tick();assert.equal((await f.outbox.rows()).length,1);assert.ok(f.statuses.at(-1).detail.includes('格式'));
});
test('foreign ack entries and partial confirmations do not acknowledge other messages',async()=>{
 const f=await fixture({fetch:async(url,init)=>{
  if(String(url).endsWith('/time'))return Response.json({serverTimeMs:Date.now()});const b=JSON.parse(String(init?.body));
  return Response.json({batchId:b.batchId,accepted:[{id:'foreign',sessionId:'session',revision:1}],rejected:[]});
 }});await f.outbox.enqueue(grant,message());await f.client.tick();assert.equal((await f.outbox.rows()).length,1);
});
test('permanent reject remains visible and retryable reject remains pending',async()=>{
 const f=await fixture({fetch:async(url,init)=>{
  if(String(url).endsWith('/time'))return Response.json({serverTimeMs:Date.now()});const b=JSON.parse(String(init?.body));
  return Response.json({batchId:b.batchId,accepted:[],rejected:b.messages.map((m:any)=>({id:m.id,sessionId:'session',revision:m.revision,code:'invalid',retryable:m.id==='retry'}))});
 }});await f.outbox.enqueue(grant,message('permanent'));await f.outbox.enqueue(grant,message('retry'));await f.client.tick();
 const rows=await f.outbox.rows();assert.equal(rows.find(r=>r.message.id==='permanent')?.state,'rejected');assert.equal(rows.find(r=>r.message.id==='retry')?.state,'pending');
});
test('source switch never uploads another source queued messages',async()=>{
 const f=await fixture();await f.outbox.enqueue(grant,message());f.setSettings({sourceId:'different',token:'different-token'});await f.client.tick();assert.equal(f.requests.length,0);assert.equal((await f.outbox.rows()).length,1);
});
test('only explicitly granted session is repaired from local history',async()=>{
 const f=await fixture({scan:async()=>({rows:[message('allowed'),message('foreign',1,'other')]})});await f.client.tick();const b=f.requests.find(r=>r.body)?.body;assert.deepEqual(b.messages.map((m:any)=>m.id),['allowed']);
});
test('stop cancels an active request without consuming queued messages',async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 const f=await fixture({fetch:async(_url,init)=>new Promise((_resolve,reject)=>{entered();init?.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});
 await f.outbox.enqueue(grant,message());const ticking=f.client.tick();await started;f.client.stop();await ticking;assert.equal((await f.outbox.rows()).length,1);
});
test('full queue rejects additions without throwing synchronously from notify',async()=>{
 const f=await fixture({limit:1});await f.outbox.enqueue(grant,message('first'));await assert.rejects(f.outbox.enqueue(grant,message('next')));
 assert.equal((await f.outbox.rows()).length,1);assert.equal(f.client.notify([message('next')]),undefined);
});

test('ten thousand queued messages have bounded upload batches and retain excess on quota',async()=>{
 const f=await fixture({limit:10000});
 for(let i=0;i<10000;i++)await f.outbox.enqueue(grant,message('bulk-'+String(i).padStart(5,'0')));
 await assert.rejects(f.outbox.enqueue(grant,message('overflow')));
 assert.equal((await f.outbox.sample('source')).pending,10000);
 await f.client.tick();assert.equal(f.requests.find(r=>r.body)?.body.messages.length,50);
 assert.equal((await f.outbox.sample('source')).pending,9950);
});

test('recorder rolls segments and commits final files while upload is stalled',async()=>{
 let entered!:()=>void;const started=new Promise<void>(resolve=>entered=resolve);
 const f=await fixture({fetch:async(_url,init)=>new Promise((_resolve,reject)=>{entered();init?.signal?.addEventListener('abort',()=>reject(Error('aborted')),{once:true});})});
 await f.outbox.enqueue(grant,message());const upload=f.client.tick();await started;
 const status:any[]=[],committed:string[]=[],appended:string[]=[];
 class FakeMediaRecorder {
  static isTypeSupported(){return true;}
  state='inactive';onstart:(()=>void)|null=null;ondataavailable:((e:any)=>void)|null=null;onstop:(()=>void)|null=null;onerror:((e:any)=>void)|null=null;
  start(){this.state='recording';queueMicrotask(()=>this.onstart?.());}
  stop(){this.state='inactive';queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(['complete-synthetic-segment']),timecode:10});this.onstop?.();});}
 }
 const previous=(globalThis as any).MediaRecorder;(globalThis as any).MediaRecorder=FakeMediaRecorder;
 try{
  const recorder=new DurableRecorder({}as MediaStream,{sessionId:'capture-session',segmentSeconds:.015,folder:{name:'fake'}as any,
   journal:{async createSegment(){return{}as any;},async appendChunk(id:string){appended.push(id);},async finishSegment(){},async writeSegmentFiles(id:string){committed.push(id);return id+'.webm';}},
   recorderFactory:()=>new FakeMediaRecorder()as any,onStatus:e=>status.push(e)});
  await recorder.start();await new Promise(r=>setTimeout(r,70));await recorder.stop();
  assert.ok(committed.length>=3,`Expected >=3 committed segments, got ${committed.length}`);
  assert.equal(appended.length,committed.length);assert.equal(status.filter(s=>s.event==='segment'&&s.savedToDirectory).length,committed.length);
  assert.equal((await f.outbox.sample('source')).pending,1);
 }finally{(globalThis as any).MediaRecorder=previous;f.client.stop();await upload;}
});

for(const status of [500,401])test(`ingest HTTP ${status} after successful clock calibration preserves pending data`,async()=>{
 const paths:string[]=[];
 const f=await fixture({fetch:async(url)=>{
  paths.push(String(url));
  return String(url).endsWith('/time')?Response.json({serverTimeMs:Date.now()}):new Response('',{status});
 }});
 await f.outbox.enqueue(grant,message());await f.client.tick();await f.client.tick();
 assert.equal((await f.outbox.sample('source')).pending,1);
 assert.equal(paths.filter(p=>p.endsWith('/time')).length,1);
 assert.equal(paths.filter(p=>p.endsWith('/ingest/batches')).length,status===401?1:2);
});

test('foreign acknowledgements cannot make the visible pending count falsely reach zero',async()=>{
 const f=await fixture({fetch:async(url,init)=>{
  if(String(url).endsWith('/time'))return Response.json({serverTimeMs:Date.now()});
  const b=JSON.parse(String(init?.body));return Response.json({batchId:b.batchId,accepted:[{id:'not-in-this-batch',sessionId:'session',revision:1}],rejected:[]});
 }});
 await f.outbox.enqueue(grant,message());await f.client.tick();
 assert.equal((await f.outbox.sample('source')).pending,1);
 assert.equal(f.statuses.at(-1).pending,1,'UI count must reflect actual unconfirmed rows');
});
test('fractional monotonic capture timestamps are converted only at the integer-ms wire boundary',async()=>{
 const f=await fixture();const local={...message(),firstObservedAtMs:1700000000000.25,lastObservedAtMs:1700000000000.875};
 await f.outbox.enqueue(grant,local);await f.client.tick();const sent=f.requests.find(r=>r.body)?.body.messages[0];
 assert.equal(sent.firstObservedAtMs,1700000000000);assert.equal(sent.lastObservedAtMs,1700000000001);
 assert.equal(local.firstObservedAtMs,1700000000000.25,'Local timing must not be mutated for recording');
 assert.equal((await f.outbox.sample('source')).pending,0);
});

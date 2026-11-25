/** Real user text stays outside the repository. Dry-run performs no requests. */
import{parseArgs}from'node:util';import{createHash}from'node:crypto';import{readHistory,historySummary}from'./history.mjs';
const{values}=parseArgs({options:{input:{type:'string',multiple:true},source:{type:'string',default:'history'},offset:{type:'string',default:'+08:00'},server:{type:'string'},'token-env':{type:'string',default:'QQSG_REPLAY_TOKEN'},realm:{type:'string',default:'history-test'},line:{type:'string',default:'1'},'allow-remote':{type:'boolean',default:false},limit:{type:'string'}}});
if(!values.input?.length)throw Error('Usage: node tests/phase2/replay-history.mjs --input <messages.txt> [--input <other.txt>]');
const reports=[];
let base;
if(values.server){base=new URL(values.server);if(!['127.0.0.1','localhost','[::1]'].includes(base.hostname)&&!values['allow-remote'])throw Error('Remote replay requires explicit --allow-remote');if(!process.env[values['token-env']])throw Error('Replay token environment variable missing');}
const limit=values.limit===undefined?Infinity:Number(values.limit);if(!(limit>0))throw Error('Invalid --limit');
for(const[i,input]of values.input.entries()){
 const sourceId=values.input.length===1?values.source:`${values.source}-${i+1}`,r=await readHistory(input,sourceId,values.offset);
 const report={input,sourceId,...historySummary(r.messages),rejectedLines:r.rejected};reports.push(report);
 if(!base)continue;
 const sessionId='history-'+createHash('sha256').update(input+sourceId).digest('hex').slice(0,24);
 const rows=r.messages.slice(0,limit).map(({line,...m})=>({...m,sessionId}));let accepted=0,rejected=0;
 const started=performance.now();
 for(let n=0;n<rows.length;n+=100){
  const messages=rows.slice(n,n+100),batchId=createHash('sha256').update(`${sessionId}:${n}`).digest('hex').slice(0,32);
  const payload={schemaVersion:2,batchId,sourceId,sessionId,context:{sessionStartedAtMs:rows[0]?.firstObservedAtMs,realm:values.realm,line:values.line,clockOffsetMs:0,clockUncertaintyMs:0},messages};
  const response=await fetch(new URL('/fighting/api/v1/ingest/batches',base),{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env[values['token-env']]},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});
  if(!response.ok)throw Error(`Replay request failed: HTTP ${response.status}`);
  const ack=await response.json();if(ack.batchId!==batchId||!Array.isArray(ack.accepted)||!Array.isArray(ack.rejected))throw Error('Invalid replay acknowledgement');
  accepted+=ack.accepted.length;rejected+=ack.rejected.length;
  if(ack.accepted.length+ack.rejected.length!==messages.length)throw Error('Replay response missing items');
 }
 Object.assign(report,{sent:rows.length,accepted,rejected,durationMs:Math.round(performance.now()-started)});
}
console.log(JSON.stringify({mode:base?'upload':'dry-run',reports},null,2));

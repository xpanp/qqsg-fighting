/** Isolated local integration harness. Password exists only in child environment. */
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,open,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{binary:{type:'string'},port:{type:'string',default:'18780'},'history-root':{type:'string'}}});
if(!values.binary)throw Error('Usage: node tests/phase2/run-http.mjs --binary <server.exe>');
const runtimeRoot=resolve('.tools/phase2-validation');await mkdir(runtimeRoot,{recursive:true});
const dir=await mkdtemp(join(runtimeRoot,'http-'));
const base='http://127.0.0.1:'+values.port,password=randomBytes(24).toString('hex');
const args=['--data-dir',dir,'--listen','127.0.0.1:'+values.port,'--origin',base,'--insecure-local'];
const env={...process.env,QQSG_ADMIN_PASSWORD:password,QQSG_TEST_ADMIN_PASSWORD:password,QQSG_TEST_SERVER:base};
async function run(command,args,options={}){const child=spawn(command,args,{env,stdio:'inherit',windowsHide:true,...options});return await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code));});}
const binary=resolve(values.binary);
const logPath=join(dir,'server.log'),log=await open(logPath,'a');
if(await run(binary,[...args,'--init-admin'],{stdio:['ignore',log.fd,log.fd]})){await log.close();throw Error('Isolated admin init failed; see '+logPath);}
const server=spawn(binary,args,{env,stdio:['ignore',log.fd,log.fd],windowsHide:true});
try{
 let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(base+'/fighting/api/v1/admin/session');if(r.status===401){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}
 if(!ready)throw Error('Isolated backend failed to become ready; see '+logPath);
 console.log(JSON.stringify({server:base,runtimeDirectory:dir,mode:'isolated-http'}));
 process.exitCode=await run(process.execPath,['--test','tests/phase2/backend-http.test.mjs'])??1;
 if(process.exitCode===0&&values['history-root'])process.exitCode=await run(process.execPath,['tests/phase2/replay-server-history.mjs','--input',values['history-root']])??1;
}finally{if(server.exitCode===null){server.kill();await new Promise(r=>server.once('close',r));}await log.close();if(process.exitCode)console.error('Backend validation failed; server log: '+logPath);}

import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
export function parseTimestamp(value,offset='+08:00') {
 const m=String(value).trim().match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d{1,3})?(Z|[+-]\d\d:\d\d)?$/);
 if(!m)throw Error('Invalid historical timestamp');
 const result=Date.parse(`${m[1]}T${m[2]}${m[3]??''}${m[4]??offset}`);
 if(!Number.isFinite(result))throw Error('Invalid historical timestamp');return result;
}
export function parseMessageText(text,sourceId,offset='+08:00'){
 const messages=[],rejected=[];
 for(const [index,original]of text.replace(/^\uFEFF/,'').split(/\r?\n/).entries()){
  if(!original.trim())continue;
  const m=original.match(/^(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)?)\s{2,}(.*)$/);
  if(!m||!m[2].trim()){rejected.push(index+1);continue;}
  try{const observed=parseTimestamp(m[1],offset),text=m[2].trim(),gameTime=text.match(/\[\s*地\s*图\s*\]\s*\[(\d\d:\d\d:\d\d)\]/)?.[1];
   messages.push({id:createHash('sha256').update(`${sourceId}:${index+1}:${original}`).digest('hex').slice(0,32),text,revision:1,firstObservedAtMs:observed,lastObservedAtMs:observed,observations:1,...(gameTime?{gameTime}:{}),line:index+1});
  }catch{rejected.push(index+1);}
 }return{messages,rejected};
}
export async function readHistory(input,sourceId,offset){return parseMessageText(await readFile(input,'utf8'),sourceId,offset);}
/** fighting2 name_aliases.tsv is OCR spelling TAB standard name (reverse of some newer exports). */
export function parseLegacyAliases(text){return text.replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')).map(row=>{const fields=row.split('\t');if(fields.length!==2||fields.some(x=>!x.trim()))throw Error('Invalid historical alias row');const[alias,canonical]=fields.map(x=>x.trim());return{canonical,alias};});}
export function historySummary(messages){const times=messages.map(m=>m.firstObservedAtMs);return{messages:messages.length,mapMessages:messages.filter(m=>/^\[\s*地\s*图\s*\]/.test(m.text)).length,gameTimes:messages.filter(m=>m.gameTime).length,exactTextRepeats:messages.length-new Set(messages.map(m=>m.text)).size,firstObservedAt:times.length?new Date(Math.min(...times)).toISOString():null,lastObservedAt:times.length?new Date(Math.max(...times)).toISOString():null};}

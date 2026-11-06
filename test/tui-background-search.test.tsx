import {expect,test} from 'bun:test'
import React,{act,useEffect} from 'react'
import {Text} from 'ink'
import {render} from 'ink-testing-library'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {IndexDb} from '../src/core/db'
import {DEFAULT_CONFIG} from '../src/config'
import {App} from '../src/tui/App'
import {buildAdapter} from '../src/core/adapter'
import {validateManifest} from '../src/manifests/load'
import {useSessions,type SessionsState} from '../src/tui/useSessions'
import type {ExecPlan,SessionRef} from '../src/types'

test('typing into a disk-backed picker does not execute FTS on the input thread', async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nekyia-background-'))
 const db=IndexDb.open(join(dir,'index.db'))
 const ref:SessionRef={uid:'codex:a',nativeId:'a',client:'codex',cwd:'/project',title:'Appengine migration',gitBranch:null,startedAt:1,endedAt:2,turns:1,parentNativeId:null,tier:'resume',origin:'manifest',sourcePaths:[],fingerprint:'a'}
 db.upsertHydrated({ref,prompts:['appengine search'],prose:[],dialogue:[{role:'user',text:'appengine search'}],files:[],truncated:false})
 let foregroundReads=0,state!:SessionsState
 let settle!:(value:SessionsState)=>void
 const settled=new Promise<SessionsState>(resolve=>{settle=resolve})
 const original=db.ftsSearch.bind(db)
 db.ftsSearch=(expression)=>{foregroundReads++;return original(expression)}
 function Harness(){const value=useSessions(db,DEFAULT_CONFIG,'/project');useEffect(()=>{state=value;if(value.text==='appengine search'&&!value.searchPending)settle(value)},[value]);return <Text>{value.text}</Text>}
 const view=render(<Harness/>)
 try{
  const environment=globalThis as any
  environment.IS_REACT_ACT_ENVIRONMENT=true
  act(()=>state.setText('a'))
  expect(view.lastFrame()).toContain('a')
  expect(foregroundReads).toBe(0)
  act(()=>state.setText('appengine'))
  act(()=>state.setText('appengine search'))
  delete environment.IS_REACT_ACT_ENVIRONMENT
  const complete=await settled
  expect(complete.rows.map(row=>row.uid)).toEqual(['codex:a'])
  expect(complete.matchEvidence?.text).toContain('appengine search')
  expect(foregroundReads).toBe(0)
 }finally{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;act(()=>view.unmount());db.close();rmSync(dir,{recursive:true,force:true});delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT}
})


test('Enter flushes the upstream typing pause and waits for the latest background result',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nekyia-background-enter-')),db=IndexDb.open(join(dir,'index.db'))
 for(const [id,text,time] of [['alpha','alpha work',1],['beta','beta work',2]] as const){
  const ref:SessionRef={uid:'claude:'+id,nativeId:id,client:'claude',cwd:'/project',title:text,gitBranch:null,startedAt:time,endedAt:time,turns:1,parentNativeId:null,tier:'resume',origin:'manifest',sourcePaths:[],fingerprint:id}
  db.upsertHydrated({ref,prompts:[text],prose:[],dialogue:[{role:'user',text}],files:[],truncated:false})
 }
 const adapter=buildAdapter(validateManifest({schema:1,id:'claude',name:'Claude',roots:['/none'],format:'jsonl-transcript',tier:'resume',jsonl:{glob:'*.jsonl',variant:'claude'},resume:{cmd:'claude',args:['--resume','{id}'],cwd:'{cwd}'}}))
 let resolve!:(plan:ExecPlan)=>void
 const executed=new Promise<ExecPlan>(done=>{resolve=done}),plans:ExecPlan[]=[]
 let ready!:()=>void,typed!:()=>void,observed:any
 const initialized=new Promise<void>(done=>{ready=done})
 const changed=new Promise<void>(done=>{typed=done})
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter]} cwd="/project" now={1800000000000} searchSettleMs={10000} rows={30} columns={100}
  onStateChange={value=>{observed=value;ready();if(value.text==='alpha')typed()}}
  onExec={plan=>{plans.push(plan);resolve(plan)}} onPath={()=>true} checkResumePlan={()=>({ok:true})}
  bookmarkStore={{load:()=>({state:{version:1,uids:[]},warning:null,writable:false}),set:async()=>{throw Error('unexpected bookmark write')},remove:async()=>{throw Error('unexpected bookmark write')}}}/>)
 try{
  await initialized
  await new Promise<void>(resolve=>setImmediate(resolve))
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  act(()=>view.stdin.write('alpha'));delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT
  await new Promise<void>(resolve=>setImmediate(resolve))
  await changed
  expect(observed.text).toBe('alpha')
  expect(observed.selectedUid).toBe('claude:beta')
  await new Promise<void>(resolve=>setImmediate(resolve))
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  act(()=>view.stdin.write('\r'))
  delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT
  const plan=await executed
  expect(plan).toMatchObject({kind:'resume',cmd:'claude',args:['--resume','alpha']})
  expect(plans).toHaveLength(1)
 }finally{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;act(()=>view.unmount());delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;db.close();rmSync(dir,{recursive:true,force:true})}
})

test('closing Help during a held background search never replays Escape against the picker',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nekyia-overlay-search-')),db=IndexDb.open(join(dir,'index.db'))
 const ref:SessionRef={uid:'claude:a',nativeId:'a',client:'claude',cwd:'/project',title:'alpha work',gitBranch:null,startedAt:1,endedAt:2,turns:1,parentNativeId:null,tier:'resume',origin:'manifest',sourcePaths:[],fingerprint:'a'}
 db.upsertHydrated({ref,prompts:['alpha work'],prose:[],dialogue:[{role:'user',text:'alpha work'}],files:[],truncated:false})
 const NativeWorker=globalThis.Worker
 let holding=true,notify!:()=>void
 const held=new Promise<void>(resolve=>{notify=resolve}),jobs:Array<()=>void>=[]
 function GatedWorker(...args:ConstructorParameters<typeof Worker>){
  const worker=new NativeWorker(...args),post=worker.postMessage.bind(worker)
  worker.postMessage=((message:any,...rest:any[])=>{
   if(holding&&message.kind==='job'){jobs.push(()=>post(message,...rest));notify()}
   else post(message,...rest)
  }) as typeof worker.postMessage
  return worker
 }
 globalThis.Worker=GatedWorker as unknown as typeof Worker
 let initialize!:()=>void,finish!:()=>void,observe:any
 const initialized=new Promise<void>(resolve=>{initialize=resolve})
 const completed=new Promise<void>(resolve=>{finish=resolve})
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/project" now={1800000000000} searchSettleMs={10000} rows={30} columns={100}
  onStateChange={value=>{observe=value;initialize();if(!holding&&value.text==='alpha'&&value.selectedUid==='claude:a')finish()}}
  onExec={()=>{throw Error('unexpected launch')}}
  bookmarkStore={{load:()=>({state:{version:1,uids:[]},warning:null,writable:false}),set:async()=>{throw Error('unexpected write')},remove:async()=>{throw Error('unexpected write')}}}/>)
 try{
  await initialized
  await new Promise<void>(resolve=>setImmediate(resolve))
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  act(()=>view.stdin.write('alpha'))
  act(()=>view.stdin.write('\x1bOP'))
  delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT
  await held
  await new Promise<void>(resolve=>setImmediate(resolve))
  expect(view.lastFrame()).toContain('Help — browse shortcuts')
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  act(()=>view.stdin.write('\x1b[27u'))
  delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT
  holding=false;for(const job of jobs.splice(0))job()
  await completed
  await new Promise<void>(resolve=>setImmediate(resolve))
  expect(view.lastFrame()).toContain('alpha')
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true
  act(()=>view.stdin.write('x'))
  expect(observe.text).toBe('alphax')
 }finally{
  globalThis.Worker=NativeWorker
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;act(()=>view.unmount());delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT
  db.close();rmSync(dir,{recursive:true,force:true})
 }
})

/** Seeds a disk-backed index, which is what turns the background worker on. */
function diskIndex(prefix:string,sessions:ReadonlyArray<readonly [string,string,number]>){
 const dir=mkdtempSync(join(tmpdir(),prefix)),db=IndexDb.open(join(dir,'index.db'))
 for(const [id,text,time] of sessions){
  const ref:SessionRef={uid:'claude:'+id,nativeId:id,client:'claude',cwd:'/project',title:id,gitBranch:null,startedAt:time,endedAt:time,turns:1,parentNativeId:null,tier:'resume',origin:'manifest',sourcePaths:[],fingerprint:id}
  db.upsertHydrated({ref,prompts:[text],prose:[],dialogue:[{role:'user',text}],files:[],truncated:false})
 }
 return {db,cleanup:()=>{db.close();rmSync(dir,{recursive:true,force:true})}}
}

/** Replaces Worker so jobs of the chosen kinds wait until released; later jobs then pass straight through. */
function gateWorkers(holds:(job:{kind:string})=>boolean){
 const NativeWorker=globalThis.Worker,jobs:Array<()=>void>=[]
 const waiters:Array<()=>void>=[]
 let holding=true
 function GatedWorker(...args:ConstructorParameters<typeof Worker>){
  const worker=new NativeWorker(...args),post=worker.postMessage.bind(worker)
  worker.postMessage=((message:any,...rest:any[])=>{
   if(holding&&message.kind==='job'&&holds(message.job)){jobs.push(()=>post(message,...rest));for(const w of waiters.splice(0))w()}
   else post(message,...rest)
  }) as typeof worker.postMessage
  return worker
 }
 globalThis.Worker=GatedWorker as unknown as typeof Worker
 return {
  held:()=>jobs.length?Promise.resolve():new Promise<void>(resolve=>waiters.push(resolve)),
  release:()=>{holding=false;for(const job of jobs.splice(0))job()},
  restore:()=>{globalThis.Worker=NativeWorker},
 }
}
const bookmarks={load:()=>({state:{version:1 as const,uids:[]},warning:null,writable:false}),set:async()=>{throw Error('unexpected write')},remove:async()=>{throw Error('unexpected write')}}
const claude=buildAdapter(validateManifest({schema:1,id:'claude',name:'Claude',roots:['/none'],format:'jsonl-transcript',tier:'resume',jsonl:{glob:'*.jsonl',variant:'claude'},resume:{cmd:'claude',args:['--resume','{id}'],cwd:'{cwd}'}}))
const press=(view:{stdin:{write:(s:string)=>void}},input:string)=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;act(()=>view.stdin.write(input));delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT}
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve))
async function until(check:()=>boolean,ms=3000){const end=Date.now()+ms;while(!check()){if(Date.now()>end)throw Error('timed out');await new Promise(r=>setTimeout(r,10))}}

test('a deferred Enter is cancelled when the query changes before its search answers',async()=>{
 const {db,cleanup}=diskIndex('nekyia-cancel-enter-',[['alpha','alpha work',1],['alphax','alphax work',2]])
 const gate=gateWorkers(job=>job.kind==='search')
 const plans:ExecPlan[]=[]
 let observed:any
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[claude]} cwd="/project" now={1800000000000} searchSettleMs={200} rows={30} columns={100}
  onStateChange={value=>{observed=value}} onExec={plan=>{plans.push(plan)}} onPath={()=>true} checkResumePlan={()=>({ok:true})} bookmarkStore={bookmarks}/>)
 try{
  await until(()=>observed!==undefined);await turn()
  press(view,'alpha')
  press(view,'\r')
  await gate.held()
  // The Enter above is waiting for this search; editing the query must drop it.
  press(view,'x')
  await until(()=>observed?.text==='alphax')
  gate.release()
  // Settled on the edited query: only alphax matches it, and nothing is searching.
  await until(()=>{const frame=view.lastFrame()??'';return !frame.includes('Searching')&&!/alpha\s*$/mu.test(frame)})
  await new Promise(r=>setTimeout(r,50))
  expect(plans).toEqual([])
 }finally{gate.restore();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;act(()=>view.unmount());delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;cleanup()}
})

test('a restored search does not warn that its selection was lost while the worker answers',async()=>{
 const {db,cleanup}=diskIndex('nekyia-restore-',[['alpha','alpha work',1],['beta','alpha beta',2]])
 const gate=gateWorkers(job=>job.kind==='search')
 let observed:any
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[claude]} cwd="/project" now={1800000000000} rows={30} columns={100}
  initialState={{text:'alpha',filters:{scope:null,client:null,time:{kind:'preset',preset:'all'},sort:'auto',bookmarkedOnly:false},selectedUid:'claude:alpha',selectedIndex:1,listTop:0,reader:null}}
  onStateChange={value=>{observed=value}} onExec={()=>{}} onPath={()=>true} checkResumePlan={()=>({ok:true})} bookmarkStore={bookmarks}/>)
 try{
  await gate.held();await turn()
  expect(view.lastFrame()).not.toContain('no longer matches')
  gate.release()
  await until(()=>observed?.selectedUid==='claude:alpha')
  await turn()
  expect(view.lastFrame()).not.toContain('no longer matches')
 }finally{gate.restore();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;act(()=>view.unmount());delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;cleanup()}
})

test('Ctrl+O before the selected row\'s evidence arrives opens history at the match',async()=>{
 const filler=Array.from({length:60},(_,i)=>`line ${i} of unrelated work`).join('\n')
 const {db,cleanup}=diskIndex('nekyia-late-anchor-',[['newer','zephyr mentioned once',3],['older',`${filler}\nzephyr anchored here`,1]])
 const gate=gateWorkers(job=>job.kind==='evidence')
 let observed:any
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[claude]} cwd="/project" now={1800000000000} rows={20} columns={100}
  onStateChange={value=>{observed=value}} onExec={()=>{}} onPath={()=>true} checkResumePlan={()=>({ok:true})} bookmarkStore={bookmarks}/>)
 try{
  await until(()=>observed!==undefined);await turn()
  press(view,'zephyr')
  await until(()=>observed?.text==='zephyr'&&observed?.selectedUid!=null)
  await turn()
  // Move to the row whose evidence the search answer did not carry.
  const other=observed.selectedUid==='claude:newer'?'claude:older':'claude:newer'
  press(view,'\u001b[B')
  await until(()=>observed?.selectedUid===other)
  await gate.held()
  press(view,'\u000f')
  await turn()
  expect(observed.reader).toBeNull()
  gate.release()
  await until(()=>observed?.reader!=null)
  expect(observed.reader.anchor.uid).toBe(other)
  expect(observed.reader.anchor.ordinal).not.toBeNull()
 }finally{gate.restore();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;act(()=>view.unmount());delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;cleanup()}
})

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IndexDb } from '../src/core/db'
import { readSessionSnapshot } from '../src/core/query'
import { DEFAULT_CONFIG } from '../src/config'
import { BackgroundSearch } from '../src/tui/search-background'
import type { SessionRef } from '../src/types'

function fixture() {
 const dir=mkdtempSync(join(tmpdir(),'nekyia-worker-')),path=join(dir,'index.db')
 const db=IndexDb.open(path)
 for(const [id,text] of [['app','appengine search migration'],['other','unrelated work']] as const){
  const ref:SessionRef={uid:id,nativeId:id,client:'codex',cwd:'/project',title:'',gitBranch:null,startedAt:1,endedAt:2,turns:1,parentNativeId:null,tier:'resume',origin:'manifest',sourcePaths:[],fingerprint:'a'}
  db.upsertHydrated({ref,prompts:[text],prose:[],dialogue:[{role:'user',text}],files:[],truncated:false})
 }
 return {db,path,dir,service:new BackgroundSearch(path,readSessionSnapshot(db))}
}

test('background search coalesces keystrokes and returns only the latest rows and evidence',async()=>{
 const f=fixture()
 try{
  const first=f.service.request({kind:'search',cfg:DEFAULT_CONFIG,opts:{text:'a',matchMode:'prefix-last'}})
  const middle=f.service.request({kind:'search',cfg:DEFAULT_CONFIG,opts:{text:'unrelated'}})
  const latest=f.service.request({kind:'search',cfg:DEFAULT_CONFIG,opts:{text:'appengine search',matchMode:'prefix-last'}})
  const [a,b,c]=await Promise.all([first,middle,latest])
  expect(a).toBeNull();expect(b).toBeNull()
  expect(c?.rows.map(row=>row.uid)).toEqual(['app'])
  expect(c?.evidence?.text).toContain('appengine search')
  expect(c?.evidence?.anchor).toEqual({ordinal:0,offset:0})
 }finally{f.service.close();f.db.close();rmSync(f.dir,{recursive:true,force:true})}
})

test('background evidence reads preserve selected-session identity',async()=>{
 const f=fixture()
 try{
  const answer=await f.service.request({kind:'evidence',uid:'other',expression:'"unrelated"'})
  expect(answer?.evidence?.uid).toBe('other')
  expect(answer?.evidence?.text).toContain('unrelated work')
  const absent=await f.service.request({kind:'evidence',uid:'app',expression:'"unrelated"'})
  expect(absent?.evidence).toBeNull()
 }finally{f.service.close();f.db.close();rmSync(f.dir,{recursive:true,force:true})}
})

test('closing a busy search settles queued requests and rejects new work',async()=>{
 const f=fixture()
 try{
  const first=f.service.request({kind:'search',cfg:DEFAULT_CONFIG,opts:{text:'a'}})
  const latest=f.service.request({kind:'search',cfg:DEFAULT_CONFIG,opts:{text:'appengine'}})
  f.service.close()
  expect(await first).toBeNull();expect(await latest).toBeNull()
  await expect(f.service.request({kind:'evidence',uid:'app',expression:'"appengine"'})).rejects.toThrow('restart the picker')
 }finally{f.service.close();f.db.close();rmSync(f.dir,{recursive:true,force:true})}
})

test('worker initialization errors reach the caller without synchronous fallback',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'nekyia-worker-missing-'))
 const service=new BackgroundSearch(join(dir,'missing.db'),[])
 try{
  await expect(service.request({kind:'search',cfg:DEFAULT_CONFIG,opts:{text:'a'}})).rejects.toThrow()
 }finally{service.close();rmSync(dir,{recursive:true,force:true})}
})

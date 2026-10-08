import {expect,test} from 'bun:test'
import React from 'react'
import {render} from 'ink-testing-library'
import {ChainPicker} from '../src/tui/ChainPicker'
import type {SearchRef} from '../src/core/db'
const tick=()=>new Promise(resolve=>setTimeout(resolve,30))
const member:SearchRef={uid:'codex:a',client:'codex',nativeId:'a',cwd:'/proj',gitBranch:null,title:'related',startedAt:0,endedAt:0,turns:1,parentNativeId:null,tier:'search',origin:'manifest',missing:false}
test('related actions say fresh context for a search member and disabled reason prevents resume',async()=>{
 let uid=''
 const view=render(<ChainPicker items={[{...member,parentLabel:'root',matchesFilters:false}]} rows={8} columns={80} onClose={()=>{}} onInspect={()=>{}} onResume={id=>{uid=id}} actionForMember={()=>({label:'Start fresh with context',enabled:false,reason:'Launcher not installed'})}/>)
 await tick();expect(view.lastFrame()).toContain('Unknown time');expect(view.lastFrame()).toContain('outside filters')
 view.stdin.write('\r');await tick();view.stdin.write('\x1b[B');await tick()
 expect(view.lastFrame()).toContain('Start fresh with context');expect(view.lastFrame()).toContain('Launcher not installed')
 view.stdin.write('\r');await tick();expect(uid).toBe('')
 view.unmount()
})
test('related native action captures exact member UID',async()=>{
 let uid=''
 const view=render(<ChainPicker items={[{...member,tier:'resume',parentLabel:'root',matchesFilters:true}]} rows={8} columns={80} onClose={()=>{}} onInspect={()=>{}} onResume={id=>{uid=id}} actionForMember={()=>({label:'Resume session',enabled:true,reason:null})}/>)
 await tick();view.stdin.write('\r');await tick();view.stdin.write('\x1b[B');await tick();view.stdin.write('\r');await tick()
 expect(uid).toBe('codex:a');view.unmount()
})

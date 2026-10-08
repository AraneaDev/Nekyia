import {afterEach,test,expect} from 'bun:test'
import React from 'react'
import {cleanup,render} from 'ink-testing-library'
import {Actions} from '../src/tui/ActionMenu'
const tick=()=>new Promise(resolve=>setTimeout(resolve,30))
afterEach(cleanup)
test('actions search and disabled selection cannot dispatch',async()=>{
 let called=''
 const view=render(<Actions items={[
 {id:'resume',label:'Resume session',shortcut:'enter',enabled:false,reason:'Launcher not installed'},
 {id:'filters',label:'Filters',shortcut:'ctrl+g',enabled:true,reason:null},
 ]} rows={8} columns={40} onAction={id=>{called=id}} onClose={()=>{}} />)
 await tick();expect(view.lastFrame()).toContain('Launcher not installed')
 view.stdin.write('\r');await tick();expect(called).toBe('')
 view.stdin.write('Filters');await tick();view.stdin.write('\r');await tick();expect(called).toBe('filters')
 view.unmount()
})

test('menu backspace removes one complete emoji grapheme',async()=>{
 const view=render(<Actions items={[]} rows={8} columns={80} onAction={()=>{}} onClose={()=>{}}/>)
 await tick();view.stdin.write('👩‍💻');await tick();view.stdin.write('\x7f');await tick()
 expect(view.lastFrame()).toContain('Find:\n')
 expect(view.lastFrame()).not.toContain('👩')
 expect(view.lastFrame()).not.toContain('�')
 view.unmount()
})

test('compact actions show the complete unavailable reason and back control',async()=>{
 const view=render(<Actions items={[{id:'resume',label:'Resume session',shortcut:'enter',enabled:false,
 reason:'Launcher unavailable. Choose another client in settings.'}]} rows={8} columns={40} onAction={()=>{}} onClose={()=>{}}/>)
 await tick()
 const frame=view.lastFrame()!
 expect(frame).toContain('settings.')
 expect(frame).toContain('esc back')
 expect(frame.split('\n').length).toBeLessThanOrEqual(8)
 for(const line of frame.split('\n'))expect(Bun.stringWidth(line)).toBeLessThanOrEqual(40)
 view.unmount()
})

test('rapid menu navigation reaches the intended action',async()=>{
 let called=''
 const view=render(<Actions items={[
 {id:'resume',label:'Resume',shortcut:null,enabled:true,reason:null},
 {id:'filters',label:'Filters',shortcut:null,enabled:true,reason:null},
 {id:'refresh',label:'Refresh',shortcut:null,enabled:true,reason:null},
 ]} rows={8} columns={40} onAction={id=>{called=id}} onClose={()=>{}}/>)
 await tick();view.stdin.write('\x1b[B');view.stdin.write('\x1b[B');await tick()
 view.stdin.write('\r');await tick();expect(called).toBe('refresh')
 view.unmount()
})

test('short action dialogs retain the selected row when reasons wrap',async()=>{
 const view=render(<Actions items={[{id:'resume',label:'Resume session',shortcut:'enter',enabled:false,
 reason:'Launcher unavailable. Choose another client in settings.'}]} rows={5} columns={40} onAction={()=>{}} onClose={()=>{}}/>)
 await tick()
 expect(view.lastFrame()).toContain('▸ Resume session')
 expect(view.lastFrame()).toContain('esc back')
 expect(view.lastFrame()!.split('\n').length).toBeLessThanOrEqual(5)
 view.unmount()
})

test('menu retains every character typed before a repaint',async()=>{
 let called=''
 const view=render(<Actions items={[{id:'filters',label:'Filters',shortcut:null,enabled:true,reason:null}]}
 rows={8} columns={40} onAction={id=>{called=id}} onClose={()=>{}}/>)
 await tick()
 for(const letter of 'Filter')view.stdin.write(letter)
 await tick()
 expect(view.lastFrame()).toContain('Find: Filter')
 view.stdin.write('\r');await tick();expect(called).toBe('filters')
 view.unmount()
})

test('queued backspaces each remove one complete grapheme',async()=>{
 const view=render(<Actions items={[]} rows={8} columns={40} onAction={()=>{}} onClose={()=>{}}/>)
 await tick();view.stdin.write('A👩‍💻B');await tick()
 view.stdin.write('\x7f');view.stdin.write('\x7f');await tick()
 expect(view.lastFrame()).toContain('Find: A\n')
 expect(view.lastFrame()).not.toContain('👩')
 view.unmount()
})

const rows=[...document.querySelectorAll('[data-title]')]
const title=document.querySelector('#chatTitle')
const project=document.querySelector('#projectName')
const topView=document.querySelector('#topView')
const conversation=document.querySelector('#conversation')
rows.forEach((row)=>row.addEventListener('click',()=>{
  rows.forEach((item)=>item.classList.remove('selected'))
  row.classList.add('selected')
  title.textContent=row.dataset.title
  project.textContent=row.dataset.project||'Recent conversation'
  topView.textContent='Today'
  if(row.dataset.state) document.querySelector('.context-state strong').textContent=row.dataset.state
  if(!row.classList.contains('work-row')) document.querySelector('.date-line').textContent='Previous conversation · archived'
}))
const palette=document.querySelector('#palette')
document.querySelector('#commandBtn').addEventListener('click',()=>{ palette.hidden=false })
document.querySelector('.palette-backdrop').addEventListener('click',()=>{ palette.hidden=true })
document.addEventListener('keydown',(event)=>{
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){ event.preventDefault(); palette.hidden=false }
  if(event.key==='Escape') palette.hidden=true
})
document.querySelector('#newWork').addEventListener('click',()=>{
  title.textContent='New work'
  project.textContent='Choose an application to begin'
  document.querySelector('.date-line').textContent='Start a new conversation'
  conversation.querySelector('.message.user p').textContent='Tell Emerald what you want to accomplish. You can add files or choose an approved application when you are ready.'
})

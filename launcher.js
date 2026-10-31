'use strict';
// This page-side entry point can only open the extension UI. It never handles credentials.
if (!document.getElementById('aikey-launcher-v2')) {
  const button = document.createElement('button');
  button.id = 'aikey-launcher-v2';
  button.textContent = 'AIkey后续流程一键申请';
  Object.assign(button.style, {position:'fixed',right:'24px',bottom:'24px',zIndex:'2147483647',background:'#10283f',color:'#fff',border:'2px solid #43dfb1',borderRadius:'14px',padding:'14px 20px',font:'bold 15px system-ui',cursor:'pointer'});
  button.addEventListener('click', event => {
    if (event.isTrusted) chrome.runtime.sendMessage({type:'OPEN'});
  });
  document.body.append(button);
}

/**
 * overlay.js - Injected into the MAIN world to draw the in-game overlay
 * showing current opponents when the Tab key is pressed.
 */

(function() {
  'use strict';

  let opponents = [];
  let overlayContainer = null;
  let isTabPressed = false;
  let extUrl = '';
  let showCars = false;

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'ROCKETBALL_EXT_URL') {
      extUrl = e.data.url;
    }
    if (e.data && e.data.type === 'ROCKETBALL_SHOW_CARS') {
      showCars = e.data.show;
    }
  });
  // Convert TextMeshPro rich text tags to safe HTML
  function tmpToHtml(text) {
    if (!text) return 'Player';
    // Escape all HTML first to prevent XSS
    let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Simple tags: b, i, u, s, sup, sub
    s = s.replace(/&lt;(\/?(?:b|i|u|s|sup|sub))&gt;/gi, '<$1>');
    // <color=#RRGGBB> or <color=#RRGGBBAA> or <color=name>
    s = s.replace(/&lt;color=(#?[a-zA-Z0-9]+)&gt;/gi, '<span style="color:$1">');
    s = s.replace(/&lt;\/color&gt;/gi, '</span>');
    // <#RRGGBB> or <#RRGGBBAA> shorthand
    s = s.replace(/&lt;#([0-9a-fA-F]{6,8})&gt;/gi, '<span style="color:#$1">');
    // <size=N> or <size=N%>
    s = s.replace(/&lt;size=([0-9]+%?)&gt;/gi, '<span style="font-size:$1">');
    s = s.replace(/&lt;\/size&gt;/gi, '</span>');
    // <alpha=#XX>
    s = s.replace(/&lt;alpha=#([0-9a-fA-F]{2})&gt;/gi, (_, hex) => {
      return `<span style="opacity:${(parseInt(hex,16)/255).toFixed(2)}">`;
    });
    // <mark=#RRGGBB>
    s = s.replace(/&lt;mark=(#[0-9a-fA-F]+)&gt;/gi, '<span style="background:$1;padding:0 2px;border-radius:2px">');
    s = s.replace(/&lt;\/mark&gt;/gi, '</span>');
    // Strip any remaining unrecognised TMP tags
    s = s.replace(/&lt;\/?[a-zA-Z][^&]*&gt;/g, '');
    return s;
  }


  function createOverlay() {
    if (overlayContainer) return;

    overlayContainer = document.createElement('div');
    overlayContainer.id = 'rocketball-rating-overlay';
    
    // Very light styling, top right position
    Object.assign(overlayContainer.style, {
      position: 'fixed',
      top: '15px',
      right: '15px',
      zIndex: '999999',
      display: 'none',
      flexDirection: 'column',
      gap: '8px',
      fontFamily: 'sans-serif',
      pointerEvents: 'none', // Don't block game clicks
      opacity: '0.85'
    });

    document.body.appendChild(overlayContainer);
  }

  function renderOverlay() {
    if (!overlayContainer) return;
    
    overlayContainer.innerHTML = '';
    
    if (opponents.length === 0) {
      const emptyMsg = document.createElement('div');
      Object.assign(emptyMsg.style, {
        background: 'rgba(0, 0, 0, 0.6)',
        color: '#ccc',
        padding: '6px 12px',
        borderRadius: '6px',
        fontSize: '12px',
        border: '1px solid rgba(255,255,255,0.1)'
      });
      emptyMsg.textContent = 'No opponent data yet';
      overlayContainer.appendChild(emptyMsg);
      return;
    }

    // Sort by rating descending
    const sortedOpponents = [...opponents].sort((a, b) => (b.rating || 0) - (a.rating || 0));

    sortedOpponents.forEach(opp => {
      const row = document.createElement('div');
      
      Object.assign(row.style, {
        background: 'rgba(0, 0, 0, 0.75)',
        padding: '6px 12px',
        borderRadius: '6px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        borderLeft: '4px solid #3ac6fc',
        boxShadow: '0 2px 4px rgba(0,0,0,0.5)',
        backdropFilter: 'blur(2px)'
      });

      const nameSpan = document.createElement('span');
      Object.assign(nameSpan.style, {
        color: 'white',
        fontWeight: 'bold',
        fontSize: '14px',
        minWidth: '80px',
        textShadow: '1px 1px 2px black',
        display: 'flex',
        alignItems: 'center',
        gap: '6px'
      });

      const nameText = document.createElement('span');
      nameText.innerHTML = tmpToHtml(opp.name);
      nameSpan.appendChild(nameText);

      // Add car icon if body exists and we have the extension URL
      if (showCars && extUrl && opp.body && opp.body.startsWith('body.')) {
        const bodyNum = parseInt(opp.body.split('.')[1], 10);
        if (!isNaN(bodyNum)) {
          const skinFilename = bodyNum === 0 ? 'DefaultSkin.png' : `Skin${bodyNum}.png`;
          const carImg = document.createElement('img');
          carImg.src = `${extUrl}assets/texture/${skinFilename}`;
          carImg.style.width = '35px';
          carImg.style.height = '30px';
          carImg.style.objectFit = 'contain';
          // Hide if the image fails to load (e.g. missing PNG)
          carImg.onerror = () => carImg.style.display = 'none';
          nameSpan.appendChild(carImg);
        }
      }

      const ratingSpan = document.createElement('span');
      Object.assign(ratingSpan.style, {
        color: '#3ac6fc',
        fontWeight: '900',
        fontSize: '16px',
        textShadow: '0 0 5px rgba(58,198,252,0.5)'
      });
      ratingSpan.textContent = (opp.rating !== null && opp.rating !== undefined) ? Math.round(opp.rating) : '—';

      row.appendChild(nameSpan);
      row.appendChild(ratingSpan);
      
      overlayContainer.appendChild(row);
    });
  }

  // Listen for the TAB key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      isTabPressed = true;
      if (overlayContainer) {
        overlayContainer.style.display = 'flex';
      }
    }
  });

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Tab') {
      isTabPressed = false;
      if (overlayContainer) {
        overlayContainer.style.display = 'none';
      }
    }
  });

  // Listen for opponent data from ws_hook.js
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    
    if (event.data && event.data.type === 'ROCKETBALL_NEW_ROOM') {
      opponents = []; // Flush old players when joining a new room
      renderOverlay();
      return;
    }
    
    if (event.data && event.data.type === 'ROCKETBALL_OPPONENT_DETECTED') {
      const opp = event.data.data;
      
      // Update or add opponent
      const existingIdx = opponents.findIndex(o => {
        if (o.firebaseUid && opp.firebaseUid) return o.firebaseUid === opp.firebaseUid;
        return o.name && o.name === opp.name;
      });
      if (existingIdx !== -1) {
        opponents[existingIdx] = opp;
      } else {
        opponents.push(opp);
      }
      
      // Keep up to 12 players to easily support full 3v3 (6 players) plus spectators/ghosts
      if (opponents.length > 12) opponents.shift();
      
      if (!overlayContainer) createOverlay();
      renderOverlay();
    }
  });

})();

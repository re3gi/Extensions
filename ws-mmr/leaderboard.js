document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('leaderboard-container');
  
  document.getElementById('close-btn').addEventListener('click', () => {
    window.parent.postMessage({ type: 'CLOSE_LEADERBOARD' }, '*');
  });

  const showCarsCheck = document.getElementById('show-cars-checkbox');
  chrome.storage.local.get({ showCars: false }, (res) => {
    showCarsCheck.checked = res.showCars;
    if (!res.showCars) document.body.classList.add('hide-cars');
  });

  showCarsCheck.addEventListener('change', (e) => {
    const show = e.target.checked;
    if (show) {
      document.body.classList.remove('hide-cars');
    } else {
      document.body.classList.add('hide-cars');
    }
    chrome.storage.local.set({ showCars: show });
  });

  // Convert TextMeshPro rich text tags to safe HTML
  function tmpToHtml(text) {
    if (!text) return 'Unknown';
    let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/&lt;(\/?(?:b|i|u|s|sup|sub))&gt;/gi, '<$1>');
    s = s.replace(/&lt;color=(#?[a-zA-Z0-9]+)&gt;/gi, '<span style="color:$1">');
    s = s.replace(/&lt;\/color&gt;/gi, '</span>');
    // <#RRGGBB> or <#RRGGBBAA> shorthand
    s = s.replace(/&lt;#([0-9a-fA-F]{6,8})&gt;/gi, '<span style="color:#$1">');
    s = s.replace(/&lt;size=([0-9]+%?)&gt;/gi, '<span style="font-size:$1">');
    s = s.replace(/&lt;\/size&gt;/gi, '</span>');
    s = s.replace(/&lt;alpha=#([0-9a-fA-F]{2})&gt;/gi, (_, hex) => {
      return `<span style="opacity:${(parseInt(hex,16)/255).toFixed(2)}">`;
    });
    s = s.replace(/&lt;mark=(#[0-9a-fA-F]+)&gt;/gi, '<span style="background:$1;padding:0 2px;border-radius:2px">');
    s = s.replace(/&lt;\/mark&gt;/gi, '</span>');
    s = s.replace(/&lt;\/?[a-zA-Z][^&]*&gt;/g, '');
    return s;
  }

  function stripTmp(text) {
    return (text || 'Unknown').replace(/<[^>]+>/g, '');
  }

  let activeTabId = 'tab-0';

  function renderLeaderboard(db) {
    const players = Object.values(db || {});
    
    if (players.length === 0) {
      container.innerHTML = '<div class="loading-text">No players recorded yet! Play some games!</div>';
      return;
    }

    // Aggregate by game mode
    const modes = {};
    players.forEach(p => {
      if (p.modeStats) {
        for (const [rawMode, stats] of Object.entries(p.modeStats)) {
          if (rawMode.toLowerCase().includes('casual')) continue;
          
          if (stats.rating !== undefined || stats.unranked) {
            if (!modes[rawMode]) modes[rawMode] = [];
            modes[rawMode].push({ 
              name: p.name || 'Unknown',
              body: p.body,
              rating: stats.rating !== undefined ? stats.rating : -1 
            });
          }
        }
      }
    });

    if (Object.keys(modes).length === 0) {
       container.innerHTML = '<div class="loading-text">No ranked ratings recorded yet!</div>';
       return;
    }

    let tabsHtml = '';
    let contentHtml = '';
    
    // Always show these 3 tabs
    const fixedModes = ['Competitive3v3', 'Competitive2v2', 'Competitive1v1'];
    
    fixedModes.forEach((rawMode, index) => {
      const modeData = modes[rawMode] || [];
      modeData.sort((a, b) => b.rating - a.rating); // descending
      
      const displayName = rawMode.replace(/competitive/i, '').trim();
      const isActive = `tab-${index}` === activeTabId ? 'active' : '';
      
      tabsHtml += `<button class="tab-btn ${isActive}" data-target="tab-${index}">${displayName}</button>`;
      
      contentHtml += `<div class="tab-content ${isActive}" id="tab-${index}">`;
      
      if (modeData.length === 0) {
        contentHtml += `<div class="loading-text" style="font-size:22px; margin-top:30px;">No players recorded for ${displayName} yet!</div>`;
      } else {
        modeData.forEach((entry, idx) => {
          let rank = idx + 1;
          let rankClass = '';
          if (rank === 1) rankClass = 'rank-1';
          else if (rank === 2) rankClass = 'rank-2';
          else if (rank === 3) rankClass = 'rank-3';
          
          let plainName = stripTmp(entry.name);
          let richName = tmpToHtml(entry.name);
          let carHtml = '';
          if (entry.body && entry.body.startsWith('body.')) {
            const bodyNum = parseInt(entry.body.split('.')[1], 10);
            if (!isNaN(bodyNum)) {
              const skinFilename = bodyNum === 0 ? 'DefaultSkin.png' : `Skin${bodyNum}.png`;
              carHtml = `<img src="assets/texture/${skinFilename}" class="car-icon" style="width:35px;height:30px;object-fit:contain;vertical-align:middle;margin-left:6px;" onerror="this.style.display='none'">`;
            }
          }
          
          contentHtml += `
              <div class="player-row">
                <div class="rank-col ${rankClass}">#${rank}</div>
                <div class="name-col" title="${plainName}">
                  <div style="display:flex;align-items:center;">
                    <span>${richName}</span>${carHtml}
                  </div>
                </div>
                <div class="rating-col">${entry.rating !== -1 ? Math.round(entry.rating) : '—'}</div>
              </div>
          `;
        });
      }
      
      contentHtml += `</div>`;
    });

    document.getElementById('tabs-container').innerHTML = tabsHtml;
    container.innerHTML = contentHtml;
    
    // Add tab click listeners
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        
        e.target.classList.add('active');
        activeTabId = e.target.dataset.target;
        document.getElementById(activeTabId).classList.add('active');
      });
    });
  }

  // Initial render
  chrome.storage.local.get(['playersDatabase'], (result) => {
    renderLeaderboard(result.playersDatabase || {});
  });

  // Listen for live updates
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.playersDatabase) {
      renderLeaderboard(changes.playersDatabase.newValue || {});
    }
  });
});

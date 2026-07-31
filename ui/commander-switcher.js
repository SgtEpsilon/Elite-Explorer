// ui/commander-switcher.js
//
// Turns the topbar's #tb-cmdr label into a dropdown when more than one
// commander (FID) is found in the journal folder. Included on every page
// (same pattern as display-settings.js) so switching works identically
// everywhere.
//
// Deliberately dumb about page-specific state: switching just tells main
// which CMDR to scope Profile/History to, then reloads the current page.
// Every page already has full "load my data on startup" logic, so a reload
// is the simplest way to guarantee nothing stale is left on screen — no
// need to duplicate per-page refresh logic here.
(function () {
  if (!window.electronAPI || !window.electronAPI.listCommanders) return;

  function init() {
    const label = document.getElementById('tb-cmdr');
    if (!label || label.dataset.cmdrSwitcherInit) return;
    label.dataset.cmdrSwitcherInit = '1';

    const wrap = document.createElement('div');
    wrap.className = 'cmdr-switcher';

    const btn = document.createElement('button');
    btn.className = 'cmdr-switcher-btn';
    btn.type = 'button';
    btn.innerHTML = label.textContent + ' <span class="caret">&#9662;</span>';

    const menu = document.createElement('div');
    menu.className = 'cmdr-switcher-menu';

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    label.replaceWith(wrap);

    let commanders = [];

    function render() {
      const current = commanders.find(c => c.isViewing) || commanders.find(c => c.isActive);
      btn.innerHTML = (current ? 'CMDR ' + current.name : '&#8212;') + ' <span class="caret">&#9662;</span>';
      btn.classList.toggle('has-alts', commanders.length > 1);

      menu.innerHTML = '';
      for (const c of commanders) {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'cmdr-switcher-item' + (c.isViewing ? ' viewing' : '');
        item.innerHTML = '<span>' + c.name + '</span>' + (c.isActive ? '<span class="live-badge">LIVE</span>' : '');
        item.addEventListener('click', async () => {
          if (c.isViewing) { menu.classList.remove('open'); return; }
          item.disabled = true;
          await window.electronAPI.setViewingCommander(c.fid);
          location.reload();
        });
        menu.appendChild(item);
      }
    }

    async function refresh() {
      try {
        commanders = await window.electronAPI.listCommanders();
      } catch {
        commanders = [];
      }
      render();
    }

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (commanders.length <= 1) return; // nothing to switch to — plain label
      menu.classList.toggle('open');
    });
    document.addEventListener('click', () => menu.classList.remove('open'));

    refresh();
    // Journal folder can grow a new commander mid-session — keep the list
    // reasonably fresh without needing a dedicated push event per page.
    setInterval(refresh, 60000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

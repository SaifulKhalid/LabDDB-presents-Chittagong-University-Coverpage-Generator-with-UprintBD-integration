/* =============================================================================
   nav.js — Shared Navigation & Global Header / Sidebar Injection
   Vanilla JS component for generator pages (index, experiment-cover, etc.)
   ============================================================================= */
(function (global) {
  'use strict';

  var PAGE_TITLES = {
    'index.html': 'Cover Page Generator',
    'experiment-cover.html': 'Experiment Cover Generator',
    'experiment-main-cover.html': 'Main Cover Generator',
    'experiment-index.html': 'Index Page Generator',
    'admin.html': 'Academic Database & Catalogue Admin'
  };

  function getCurrentPageName() {
    var path = (global.location && global.location.pathname) ? global.location.pathname.split('/').pop() : '';
    if (!path || path === '/' || path === '') return 'index.html';
    return path;
  }

  function getHeaderHtml(subtitle) {
    return [
      '    <div class="header-inner">',
      '      <div class="brand">',
      '        <a href="index.html" class="brand-logo-wrap" title="LabDDB Home">',
      '          <img src="labddb-logo.png" alt="LabDDB" class="brand-logo" onerror="this.style.display=\'none\'" />',
      '        </a>',
      '        <div class="brand-text">',
      '          <div class="brand-heading-row">',
      '            <span class="brand-title">Lab<span class="brand-title-accent">DDB</span></span>',
      '          </div>',
      '          <div class="brand-sub">' + (subtitle || 'Cover Page Generator') + '</div>',
      '        </div>',
      '      </div>',
      '',
      '      <div class="header-actions">',
      '        <!-- Kiosk Link Status Indicator -->',
      '        <div class="bridge-status-badge" id="bridgeStatusBadge" title="UprintBD Kiosk Bridge Link Status">',
      '          <span class="pulse-dot" id="bridgeDot"></span>',
      '          <span class="bridge-status-text" id="bridgeText">Connecting kiosk…</span>',
      '        </div>',
      '',
      '        <!-- Catalogue Admin Link -->',
      '        <a href="admin.html" class="icon-btn nav-admin-btn" title="Database &amp; Course Catalogue Admin" aria-label="Catalogue Admin">',
      '          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '            <path d="M12 20h9"></path>',
      '            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>',
      '          </svg>',
      '        </a>',
      '',
      '        <!-- History Button -->',
      '        <button type="button" class="icon-btn" id="historyBtn" title="Recent OTPs &amp; Saved Drafts" aria-label="History">',
      '          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '            <circle cx="12" cy="12" r="10"></circle>',
      '            <polyline points="12 6 12 12 16 14"></polyline>',
      '          </svg>',
      '          <span class="history-badge-count" id="historyCount" style="display: none;">0</span>',
      '        </button>',
      '',
      '        <!-- Theme Toggle Button -->',
      '        <button type="button" class="icon-btn" id="themeToggleBtn" title="Toggle Dark/Light Mode" aria-label="Toggle Theme">',
      '          <svg class="sun-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '            <circle cx="12" cy="12" r="5"></circle>',
      '            <line x1="12" y1="1" x2="12" y2="3"></line>',
      '            <line x1="12" y1="21" x2="12" y2="23"></line>',
      '            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>',
      '            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>',
      '            <line x1="1" y1="12" x2="3" y2="12"></line>',
      '            <line x1="21" y1="12" x2="23" y2="12"></line>',
      '            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>',
      '            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>',
      '          </svg>',
      '          <svg class="moon-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>',
      '          </svg>',
      '        </button>',
      '      </div>',
      '    </div>',
      '',
      '    <!-- Mobile Segmented Tab Navigation -->',
      '    <nav class="mobile-tabs" id="mobileTabs" aria-label="Mobile Navigation">',
      '      <button type="button" class="tab-btn active" id="tabEditor" data-tab="editor">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>',
      '          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>',
      '        </svg>',
      '        <span>Editor Form</span>',
      '      </button>',
      '      <button type="button" class="tab-btn" id="tabPreview" data-tab="preview">',
      '        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">',
      '          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>',
      '          <polyline points="14 2 14 8 20 8"></polyline>',
      '          <line x1="16" y1="13" x2="8" y2="13"></line>',
      '          <line x1="16" y1="17" x2="8" y2="17"></line>',
      '        </svg>',
      '        <span>Live Preview</span>',
      '        <span class="tab-pill-indicator">A4</span>',
      '      </button>',
      '    </nav>'
    ].join('\n');
  }

  function getSidebarHtml(activePage) {
    var currentPage = activePage || getCurrentPageName();
    var navItems = [
      {
        href: 'index.html',
        label: 'Assignment Cover',
        svg: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>'
      },
      {
        href: 'experiment-cover.html',
        label: 'Experiment Cover',
        svg: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.31"></path><path d="M14 9.3V2"></path><path d="M8.5 2h7"></path><path d="M14 9.3a6.5 6.5 0 1 1-4 0"></path><path d="M5.52 16h12.96"></path></svg>'
      },
      {
        href: 'experiment-main-cover.html',
        label: 'Main Cover Page',
        svg: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>'
      },
      {
        href: 'experiment-index.html',
        label: 'Index Page',
        svg: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>'
      },
      {
        href: 'admin.html',
        label: 'Admin / Settings',
        svg: '<svg class="nav-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'
      }
    ];

    var linksHtml = navItems.map(function (item) {
      var isActive = (item.href === currentPage);
      return [
        '        <a href="' + item.href + '" class="sidebar-nav-link' + (isActive ? ' active' : '') + '">',
        '          ' + item.svg,
        '          <span>' + item.label + '</span>',
        '        </a>'
      ].join('\n');
    }).join('\n');

    return [
      '      <div class="sidebar-brand">',
      '        <div class="sidebar-logo-wrap">',
      '          <img src="labddb-logo.png" alt="LabDDB" class="sidebar-logo" onerror="this.style.display=\'none\'" />',
      '        </div>',
      '        <div class="sidebar-title">LabDDB</div>',
      '        <div class="sidebar-subtitle">Academic Utility Suite</div>',
      '      </div>',
      '      <nav class="sidebar-nav" aria-label="Sidebar Navigation">',
      linksHtml,
      '      </nav>'
    ].join('\n');
  }

  function injectHeader(options) {
    var opts = options || {};
    var headerEl = document.getElementById('appHeader');
    if (!headerEl) {
      headerEl = document.querySelector('header.app-header');
    }
    if (!headerEl) return;

    var currentPage = opts.active || getCurrentPageName();
    var subtitle = opts.subtitle || PAGE_TITLES[currentPage] || 'Cover Page Generator';
    headerEl.innerHTML = getHeaderHtml(subtitle);
  }

  function injectSidebar(options) {
    var opts = options || {};
    var sidebarEl = document.getElementById('appSidebar');
    if (!sidebarEl) {
      sidebarEl = document.querySelector('aside.sidebar');
    }
    if (!sidebarEl) return;

    var currentPage = opts.active || getCurrentPageName();
    sidebarEl.innerHTML = getSidebarHtml(currentPage);
  }

  function initNav(options) {
    injectHeader(options);
    injectSidebar(options);
  }

  // Auto-inject immediately for elements already parsed in the DOM,
  // and attach to DOMContentLoaded as fallback
  initNav();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      initNav();
    });
  }

  global.LabDDBNav = {
    injectHeader: injectHeader,
    injectSidebar: injectSidebar,
    initNav: initNav
  };

  global.injectHeader = injectHeader;
  global.injectSidebar = injectSidebar;
})(window);

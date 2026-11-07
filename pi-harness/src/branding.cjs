'use strict';

const DISPLAY_NAME = '金融buddy';

function applyBranding(name) {
  const key = '__workbuddyPiBranding';
  globalThis[key]?.dispose?.();
  function apply() {
    if (document.title !== name) document.title = name;
    const targets = [
      ['.logo-workbuddy-title', name],
      ['header.wb-home-header h1.wb-home-header__title > span:first-child', name + '，我帮你'],
    ];
    for (const [selector, text] of targets) {
      for (const element of document.querySelectorAll(selector)) {
        // Keep React's text nodes and adjacent title badges intact.
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode(), first = true;
        while (node) {
          const value = first ? text : '';
          if (node.data !== value) node.data = value;
          first = false;
          node = walker.nextNode();
        }
      }
    }
  }
  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  globalThis[key] = { dispose: () => observer.disconnect() };
  apply();
}

function installBranding({ app, webContents, BrowserWindow, Menu, appAsarPath }) {
  if (app.getAppPath() !== appAsarPath) throw Error('Unexpected branding application');
  app.setName(DISPLAY_NAME);
  if (Menu?.setApplicationMenu) {
    const originalSetMenu = Menu.setApplicationMenu;
    Menu.setApplicationMenu = function (menu) {
      app.setName(DISPLAY_NAME);
      const item = menu?.items?.[0];
      if (item) {
        item.label = DISPLAY_NAME;
        item.accessibilityLabel = DISPLAY_NAME;
        for (const child of item.submenu?.items ?? []) {
          if (typeof child.label === 'string') child.label = child.label.replace(/WorkBuddy/g, DISPLAY_NAME);
        }
      }
      return originalSetMenu.call(this, menu);
    };
  }
  const script = `(${applyBranding.toString()})(${JSON.stringify(DISPLAY_NAME)})`;
  const eligible = contents => {
    try {
      const url = new URL(contents.getURL());
      return url.protocol === 'file:' && decodeURIComponent(url.pathname) === appAsarPath + '/renderer/index.html';
    } catch { return false; }
  };
  const attach = contents => {
    const apply = () => {
      if (contents.isDestroyed() || !eligible(contents)) return;
      BrowserWindow.fromWebContents(contents)?.setTitle(DISPLAY_NAME);
      void contents.executeJavaScript(script).catch(() => {});
    };
    contents.on('dom-ready', apply);
    contents.on('did-finish-load', apply);
    contents.on('page-title-updated', event => {
      if (!eligible(contents)) return;
      event.preventDefault();
      BrowserWindow.fromWebContents(contents)?.setTitle(DISPLAY_NAME);
    });
    if (!contents.isLoadingMainFrame()) apply();
  };
  app.on('web-contents-created', (_event, contents) => attach(contents));
  webContents.getAllWebContents().forEach(attach);
}

module.exports = { DISPLAY_NAME, applyBranding, installBranding };

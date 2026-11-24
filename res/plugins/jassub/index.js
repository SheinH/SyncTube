'use strict';

// ASS/SSA subtitles rendered by JASSUB (libass compiled to WebAssembly).
// Without support for it in the browser, SyncTube's built-in VTT conversion is used.
synctube.jassub = class {

  constructor(obj) {
    this.api = obj.api;
    this.path = obj.path;
    this.instance = null;
    this.video = null;
    this.loadId = 0;
    if (!this.isSupported()) {
      console.warn('jassub: browser not supported, using built-in subtitles');
      return;
    }
    this.api.addSubtitleSupport('ass');
    this.api.addSubtitleSupport('ssa');
    this.lib = import(`${this.path}/jassub.js`).then(m => m.default);
    this.onFullscreenChange = this.onFullscreenChange.bind(this);
    document.addEventListener('fullscreenchange', this.onFullscreenChange);

    this.api.notifyOnVideoChange(item => this.onVideoChange(item));
    this.api.notifyOnVideoRemove(() => this.destroy());

    // plugin can load after first video was already started
    const item = this.getCurrentItem();
    if (item) this.onVideoChange(item);
  }

  isSupported() {
    return typeof WebAssembly === 'object'
      && typeof Worker === 'function'
      && typeof OffscreenCanvas === 'function'
      && 'transferControlToOffscreen' in HTMLCanvasElement.prototype;
  }

  getCurrentItem() {
    const active = document.querySelector('#queue > .queue_active');
    if (!active) return null;
    const pos = Array.prototype.indexOf.call(active.parentElement.children, active);
    return this.api.getVideoItems()[pos] ?? null;
  }

  getExtension(url) {
    const path = url.split(/[?#]/)[0];
    const dot = path.lastIndexOf('.');
    return dot == -1 ? '' : path.substr(dot + 1).toLowerCase();
  }

  // same url rules as built-in subtitles, returns absolute source url
  sourceUrl(subs) {
    if (subs.startsWith('/')) return new URL(encodeURI(subs), location.href).href;
    if (!subs.startsWith('http')) subs = `${location.protocol}//${subs}`;
    let url;
    try {
      url = new URL(subs);
    } catch (e) {
      return null;
    }
    if (url.hostname == this.api.getLocalIp() || url.hostname == this.api.getGlobalIp()) {
      return new URL(url.pathname + url.search, location.href).href;
    }
    return url.href;
  }

  // other origins are loaded directly if they allow CORS, otherwise through /proxy
  fetchUrl(url, useProxy) {
    if (!useProxy || new URL(url).origin == location.origin) return url;
    return new URL(`/proxy?url=${encodeURIComponent(url)}`, location.href).href;
  }

  async fetchOk(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
    return response;
  }

  async onVideoChange(item) {
    this.destroy();
    const loadId = ++this.loadId;
    const subs = (item.subs ?? '').trim();
    if (subs == '') return;
    const ext = this.getExtension(subs);
    if (ext != 'ass' && ext != 'ssa') return;
    const url = this.sourceUrl(subs);
    if (!url) return;

    try {
      let useProxy = false;
      let response;
      try {
        response = await this.fetchOk(this.fetchUrl(url, false));
      } catch (e) {
        if (new URL(url).origin == location.origin) throw e;
        useProxy = true;
        response = await this.fetchOk(this.fetchUrl(url, true));
      }
      const content = await response.text();
      const fonts = await this.getFonts(url, content, useProxy);
      if (loadId != this.loadId) return;
      const video = await this.waitForVideo(loadId);
      const JASSUB = await this.lib;
      if (!video || loadId != this.loadId) return;
      this.prepareVideo(video);
      this.video = video;
      this.instance = new JASSUB({
        video: video,
        subContent: content,
        // fonts used by subtitles are loaded upfront with all their styles,
        // others are loaded on demand
        fonts: fonts.used,
        availableFonts: fonts.available,
        // allow fonts installed on viewer's system, no Google Fonts requests
        queryFonts: 'local'
      });
      await this.instance.ready;
    } catch (e) {
      if (loadId != this.loadId) return;
      console.error('jassub: failed to load subtitles', e);
      this.destroy();
    }
  }

  // font index: [{url, families, names}]
  async loadFontIndex(indexUrl, useProxy) {
    try {
      const response = await fetch(this.fetchUrl(indexUrl, useProxy), { cache: 'no-cache' });
      if (!response.ok) return [];
      const fonts = (await response.json()).fonts ?? [];
      return fonts.map(font => ({
        url: this.fetchUrl(new URL(font.file.split('/').map(encodeURIComponent).join('/'), indexUrl).href, useProxy),
        families: font.families ?? [],
        names: font.names ?? []
      }));
    } catch (e) {
      console.warn(`jassub: failed to load fonts index ${indexUrl}`, e);
      return [];
    }
  }

  // fonts listed in <subs name>.fonts.json beside subtitles (see webify)
  // and in user/res/fonts/fonts.json (see extract-fonts.js)
  async getFonts(subsUrl, content, useProxy) {
    const manifestUrl = new URL(subsUrl);
    manifestUrl.pathname = manifestUrl.pathname.replace(/\.[^./]*$/, '.fonts.json');
    const lists = await Promise.all([
      this.loadFontIndex(manifestUrl.href, useProxy),
      this.loadFontIndex(new URL('/fonts/fonts.json', location.href).href, false)
    ]);
    const list = lists.flat();

    const available = {};
    for (const font of list) {
      for (const name of font.names) available[name] ??= font.url;
    }

    const usedNames = new Set();
    for (const line of content.split(/\r?\n/)) {
      if (line.startsWith('Style:')) usedNames.add(line.split(',')[1] ?? '');
    }
    for (const match of content.matchAll(/\\fn([^\\}]*)/g)) usedNames.add(match[1]);
    const names = new Set([...usedNames].map(n => n.trim().replace(/^@/, '').toLowerCase()));

    // add other styles (bold, italic) of used families
    const families = new Set();
    for (const font of list) {
      if (font.names.some(n => names.has(n))) font.families.forEach(f => families.add(f));
    }
    const urls = [...new Set(list
      .filter(font => font.families.some(f => families.has(f)))
      .map(font => font.url))];
    return { used: await this.downloadFonts(urls), available };
  }

  // a few at a time with retries, proxy has a connection limit
  async downloadFonts(urls) {
    const result = [];
    const queue = [...urls];
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift();
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const response = await this.fetchOk(url);
            result.push(new Uint8Array(await response.arrayBuffer()));
            break;
          } catch (e) {
            if (attempt == 2) console.warn(`jassub: failed to load font ${url}`, e);
            else await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          }
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return result;
  }

  // video element can be created later than video change event (hls)
  waitForVideo(loadId) {
    return new Promise(resolve => {
      const start = Date.now();
      const check = () => {
        if (loadId != this.loadId) return resolve(null);
        const el = document.getElementById('videoplayer');
        if (el instanceof HTMLVideoElement) return resolve(el);
        if (Date.now() - start > 10000) return resolve(null);
        setTimeout(check, 100);
      };
      check();
    });
  }

  prepareVideo(video) {
    // remove built-in converted tracks if they were added before plugin loading
    for (const track of video.querySelectorAll('track')) {
      if (track.label == 'ASS subtitles') track.remove();
    }
    const parent = video.parentElement;
    if (parent && getComputedStyle(parent).position == 'static') {
      parent.style.position = 'relative';
    }
  }

  // subtitles canvas is a video sibling, so fullscreen video container instead
  onFullscreenChange() {
    const video = this.video;
    if (!this.instance || !video || document.fullscreenElement != video) return;
    const parent = video.parentElement;
    if (!parent) return;
    document.exitFullscreen()
      .then(() => parent.requestFullscreen())
      .catch(e => console.error('jassub: fullscreen switch failed', e));
  }

  destroy() {
    this.loadId++;
    if (this.instance) {
      this.instance.destroy().catch(() => {});
      this.instance = null;
    }
    this.video = null;
  }
}

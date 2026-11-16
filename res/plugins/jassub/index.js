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

  // same url rules as built-in subtitles
  resolveUrl(subs) {
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
    return new URL(`/proxy?url=${encodeURIComponent(subs)}`, location.href).href;
  }

  async onVideoChange(item) {
    this.destroy();
    const loadId = ++this.loadId;
    const subs = (item.subs ?? '').trim();
    if (subs == '') return;
    const ext = this.getExtension(subs);
    if (ext != 'ass' && ext != 'ssa') return;
    const url = this.resolveUrl(subs);
    if (!url) return;

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      const content = await response.text();
      const video = await this.waitForVideo(loadId);
      const JASSUB = await this.lib;
      if (!video || loadId != this.loadId) return;
      this.prepareVideo(video);
      this.video = video;
      this.instance = new JASSUB({
        video: video,
        subContent: content,
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

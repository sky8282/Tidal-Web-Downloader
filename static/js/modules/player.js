// js/modules/player.js

import { getTrackInfo, getVideoPlaybackInfoAPI } from './api.js';
import * as dom from './dom.js';
import { updatePlayerUI, updateTrackListUI } from './ui.js';

let hls = null;

export const player = {
    tracklist: [], 
    currentIndex: -1, 
    currentTrack: null, 
    currentAlbumId: null, 
    isPlaying: false, 
    isLoading: false,
    
    activePlayer: null, 
    playerType: 'audio', 

    async playTrackAtIndex(index, albumId = null, type = 'audio') {
        if (index < 0 || index >= this.tracklist.length) { this.stop(); return; }
        
        this.stop(true);
        this.currentIndex = index; 
        this.currentTrack = this.tracklist[index];
        if (!this.currentTrack) { console.error("Track is undefined at index:", index); this.stop(); return; }
        
        this.currentAlbumId = albumId || this.currentTrack?.album?.id;
        this.playerType = type;
        this.setLoading(true);

        try {
            if (type === 'audio') {
                this.activePlayer = dom.playerAudioElement;
                const data = await getTrackInfo(this.currentTrack.id);
                this.activePlayer.src = data[2].OriginalTrackUrl;
                await this.activePlayer.play();
                
            } else if (type === 'video') {
                this.activePlayer = dom.playerVideoElement;
                dom.videoModalTitle.textContent = this.currentTrack.title || '视频播放';
                dom.videoModal.classList.add('is-visible');
                document.body.classList.add('modal-open');
                const manifestJson = await getVideoPlaybackInfoAPI(this.currentTrack.id);
                const m3u8Url = manifestJson.urls[0];
                if (!m3u8Url) {
                    throw new Error("Manifest JSON 中未找到 URL");
                }

                console.log("即将播放视频 M3U8:", m3u8Url);

                if (Hls.isSupported()) {
                    if (hls) hls.destroy();
                    hls = new Hls();
                    hls.loadSource(m3u8Url);
                    hls.attachMedia(this.activePlayer);
                    hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        this.activePlayer.play();
                    });
                    hls.on(Hls.Events.ERROR, function (event, data) {
                        console.error('HLS Error:', data);
                    });
                } else if (this.activePlayer.canPlayType('application/vnd.apple.mpegurl')) {
                    this.activePlayer.src = m3u8Url;
                    this.activePlayer.addEventListener('loadedmetadata', () => {
                        this.activePlayer.play();
                    });
                } else {
                    throw new Error("浏览器不支持 HLS 播放");
                }
            }
        } catch (err) { 
            console.error('Playback Error:', err); 
            this.stop(); 
        }
    },

    playNext() { 
        this.hasNext() ? this.playTrackAtIndex(this.currentIndex + 1, this.currentAlbumId, this.playerType) : this.stop(); 
    },

    playPrev() { 
        this.hasPrev() ? this.playTrackAtIndex(this.currentIndex - 1, this.currentAlbumId, this.playerType) : this.stop(); 
    },

    togglePlayPause() { 
        if (this.isLoading || !this.currentTrack || !this.activePlayer) return; 
        this.isPlaying ? this.activePlayer.pause() : this.activePlayer.play(); 
    },

    stop(softStop = false) {
        if (hls) {
            hls.stopLoad();
            hls.destroy();
            hls = null;
        }
        
        dom.playerAudioElement.pause(); 
        dom.playerAudioElement.src = '';
        dom.playerVideoElement.pause();
        dom.playerVideoElement.src = '';
        if (dom.videoModal.classList.contains('is-visible')) {
            dom.videoModal.classList.remove('is-visible');
        }

        const oldAlbumId = this.currentAlbumId;
        
        if (!softStop) {
            this.currentTrack = null; 
            this.currentIndex = -1; 
            this.tracklist = []; 
            this.currentAlbumId = null;
            this.playerType = 'audio';
            this.activePlayer = null;
            if (document.querySelectorAll('.modal.is-visible').length === 0) {
                 document.body.classList.remove('modal-open');
            }
        }
        
        this.setPlaying(false);
    },

    setPlaying(state) { 
        this.isPlaying = state; 
        if (this.playerType === 'audio') {
            updatePlayerUI(); 
            updateTrackListUI();
        } else {
            dom.globalPlayer.style.display = 'none';
        }
    },

    setLoading(state) { 
        this.isLoading = state; 
        if (this.playerType === 'audio') {
            updatePlayerUI();
        }
    },

    setVolume(val) { 
        dom.playerAudioElement.volume = val / 100; 
        dom.playerVideoElement.volume = val / 100;
    },

    seek(pct) { 
        if (this.playerType === 'audio' && this.activePlayer === dom.playerAudioElement && this.activePlayer.duration) {
            this.activePlayer.currentTime = (this.activePlayer.duration * pct) / 100; 
        }
    },

    hasNext: () => player.currentIndex < player.tracklist.length - 1,
    
    hasPrev: () => player.currentIndex > 0,
};
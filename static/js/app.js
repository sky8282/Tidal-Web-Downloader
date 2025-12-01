// js/app.js

import * as dom from './modules/dom.js';
import { searchAPI, getItemInfoAPI, getHomeContentAPI, getModulePagedDataAPI } from './modules/api.js';
import { settingsManager } from './modules/settings.js';
import { loadFFmpeg } from './modules/ffmpeg.js';
import { downloadAlbum, triggerDirectDownload, downloadQueue, triggerDirectVideoDownload } from './modules/downloader.js';
import { player } from './modules/player.js';
import { displayResults, updateDownloadManagerStatus, showTrackListInModal, displayHomepage, appendResultsToWall, updateDownloadQueueModal, displayArtistPage } from './modules/ui.js';

let currentSearchType = 'al';
let currentPage = 0;
let currentQuery = '';
let isLoadingMore = false;
let hasMoreResults = true;
const tidalUrlRegex = /tidal\.com\/(?:browse\/)?(track|album)\/(\d+)/;
let infiniteScrollObserver = null;

document.addEventListener('DOMContentLoaded', async () => {
    settingsManager.init();
    bindEventListeners();
    initializeHelpButtons();
    initInfiniteScrollObserver();
    loadHomepage();
});

async function loadHomepage() {
    if (dom.artistPageContainer && dom.artistPageContainer.style.display === 'block') {
        dom.artistPageContainer.style.display = 'none';
        dom.artistPageContainer.innerHTML = '';
        dom.resultsWall.style.display = 'flex';
    }

    dom.loadingIndicator.style.display = 'block';
    dom.resultsWall.innerHTML = '';
    currentQuery = '';
    hasMoreResults = false;
    if(infiniteScrollObserver) infiniteScrollObserver.disconnect();

    try {
        const homeContent = await getHomeContentAPI();
        if (homeContent && homeContent.rows && homeContent.rows.length > 0) {
            let allModules = homeContent.rows.flatMap(row => row.modules);
            
            displayHomepage(allModules);
            observeNewSentinels();

        } else {
            dom.resultsWall.innerHTML = '<p>加载主页内容失败或内容为空。</p>';
        }
    } catch (error) {
        dom.resultsWall.innerHTML = `<p>加载主页失败: ${error.message}</p>`;
    } finally {
        dom.loadingIndicator.style.display = 'none';
    }
}

async function handleUrlInput(isDownload) {
    const query = dom.searchInput.value.trim();
    const match = query.match(tidalUrlRegex);

    if (!match) {
        isDownload ? alert("请输入有效的Tidal专辑或单曲链接进行下载") : handleSearch(true);
        return;
    }
    
    const [, type, id] = match;

    try {
        if (dom.artistPageContainer && dom.artistPageContainer.style.display === 'block') {
            dom.artistPageContainer.style.display = 'none';
            dom.artistPageContainer.innerHTML = '';
            dom.resultsWall.style.display = 'flex';
        }

        dom.loadingIndicator.style.display = 'block';
        dom.resultsWall.innerHTML = '';
        const item = await getItemInfoAPI(type, id);
        if (isDownload) {
            if (type === 'album') downloadAlbum(item);
            else {
                const fullTrackItem = await getItemInfoAPI('track', id);
                triggerDirectDownload(fullTrackItem);
            }
        } else {
            const isAlbum = type === 'album';
            const results = isAlbum ? { albums: { items: [item] } } : { items: [item] };
            displayResults(results, isAlbum ? 'al' : 's', true, 0);
        }
    } catch (err) {
        alert(`处理链接失败: ${err.message}`);
    } finally {
        dom.loadingIndicator.style.display = 'none';
    }
}

async function handleSearch(forceTextSearch = false) {
    const query = dom.searchInput.value.trim();
    if (!query) return;
    if (tidalUrlRegex.test(query) && !forceTextSearch) {
        handleUrlInput(false);
        return;
    }

    if (dom.artistPageContainer && dom.artistPageContainer.style.display === 'block') {
        dom.artistPageContainer.style.display = 'none';
        dom.artistPageContainer.innerHTML = '';
        dom.resultsWall.style.display = 'flex';
    }

    currentQuery = query;
    currentPage = 0;
    hasMoreResults = true;
    if(infiniteScrollObserver) infiniteScrollObserver.disconnect();
    dom.loadingIndicator.style.display = 'block';
    try {
        const results = await searchAPI(currentSearchType, currentQuery, 0);
        hasMoreResults = displayResults(results, currentSearchType, true, currentPage);
    } catch (error) {
        dom.resultsWall.innerHTML = `<p>搜索失败: ${error.message}</p>`;
    } finally {
        dom.loadingIndicator.style.display = 'none';
    }
}

async function loadMoreSearchResults() {
    if (isLoadingMore || !hasMoreResults) return;
    isLoadingMore = true;
    currentPage++;
    dom.loadingIndicator.style.display = 'block';
    const offset = currentPage * 25;
    try {
        const results = await searchAPI(currentSearchType, currentQuery, offset);
        hasMoreResults = displayResults(results, currentSearchType, false, currentPage);
    } catch (error) {
        console.error('Failed to load more results:', error);
    } finally {
        isLoadingMore = false;
        dom.loadingIndicator.style.display = 'none';
    }
}

function initInfiniteScrollObserver() {
    infiniteScrollObserver = new IntersectionObserver(async (entries, observer) => {
        for (const entry of entries) {
            if (entry.isIntersecting) {
                const sentinel = entry.target;
                observer.unobserve(sentinel);

                const { modulePath, limit, offset, wallId, moduleType } = sentinel.dataset;

                try {
                    const data = await getModulePagedDataAPI(modulePath, offset, limit);
                    const newOffset = parseInt(offset) + data.items.length;
                    const hasMore = newOffset < data.totalNumberOfItems;
                    appendResultsToWall(wallId, data.items, moduleType);
                    
                    if (hasMore) { 
                        sentinel.dataset.offset = newOffset;
                        observer.observe(sentinel);
                    } else {
                        sentinel.remove();
                    }
                } catch (error) {
                    console.error('加载更多主页内容失败:', error);
                    sentinel.innerHTML = '加载失败';
                }
            }
        }
    }, { rootMargin: '400px 0px' });
}

function observeNewSentinels() {
    const sentinels = document.querySelectorAll('.load-more-sentinel');
    sentinels.forEach(s => infiniteScrollObserver.observe(s));
}

function initializeHelpButtons() {
    const settingsModal = document.getElementById('settings-modal');
    if (!settingsModal) return;

    settingsModal.addEventListener('click', (event) => {
        const helpBtn = event.target.closest('.help-btn');
        if (helpBtn) {
            event.stopPropagation();
            const helpId = helpBtn.dataset.helpId;
            const helpText = document.getElementById(helpId);

            if (helpText) {
                const currentlyVisible = settingsModal.querySelector('.help-text.visible');
                if (currentlyVisible && currentlyVisible !== helpText) {
                    currentlyVisible.classList.remove('visible');
                }
                helpText.classList.toggle('visible');
            }
        }
    });

    document.addEventListener('click', (event) => {
        const visibleHelpText = settingsModal.querySelector('.help-text.visible');
        if (visibleHelpText && !visibleHelpText.contains(event.target) && !event.target.closest('.help-btn')) {
            visibleHelpText.classList.remove('visible');
        }
    });
}


function bindEventListeners() {
    document.querySelector('header h1').addEventListener('click', loadHomepage);
    dom.searchButton.addEventListener('click', () => handleSearch(false));
    dom.searchInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') handleSearch(false); });
    dom.downloadUrlButton.addEventListener('click', () => handleUrlInput(true));

    document.querySelectorAll('.tab-btn').forEach(button => {
        button.addEventListener('click', (e) => {
            if(isLoadingMore) return;
            document.querySelector('.tab-btn.active').classList.remove('active');
            e.currentTarget.classList.add('active');
            currentSearchType = e.currentTarget.dataset.searchType;
            handleSearch(true);
        });
    });

    dom.downloadCancelBtn.addEventListener('click', () => downloadQueue.cancelCurrent());
    dom.downloadQueueCount.addEventListener('click', () => {
        updateDownloadQueueModal();
        dom.downloadQueueModal.classList.add('is-visible');
        document.body.classList.add('modal-open');
    });

    const closeModal = (modal) => {
        modal.classList.remove('is-visible');
        if (modal === dom.videoModal) {
            player.stop();
        }

        if (document.querySelectorAll('.modal.is-visible').length === 0) document.body.classList.remove('modal-open');
    };

    dom.tracklistModalCloseBtn.addEventListener('click', () => closeModal(dom.tracklistModal));
    dom.settingsModalCloseBtn.addEventListener('click', () => closeModal(dom.settingsModal));
    dom.downloadQueueModalCloseBtn.addEventListener('click', () => closeModal(dom.downloadQueueModal));
    dom.videoModalCloseBtn.addEventListener('click', () => closeModal(dom.videoModal));

    window.addEventListener('click', (e) => {
        if (e.target == dom.tracklistModal) closeModal(dom.tracklistModal);
        if (e.target == dom.settingsModal) closeModal(dom.settingsModal);
        if (e.target == dom.downloadQueueModal) closeModal(dom.downloadQueueModal);
        if (e.target == dom.videoModal) closeModal(dom.videoModal);
    });

    dom.settingsBtn.addEventListener('click', () => {
        dom.settingsModal.classList.add('is-visible');
        document.body.classList.add('modal-open');
    });
    
    dom.restoreDefaultsBtn.addEventListener('click', () => settingsManager.restoreDefaults());
    dom.settingsModal.addEventListener('change', () => settingsManager.updateFromUI());

    document.addEventListener('downloadQueueUpdated', () => {
        if (dom.downloadQueueModal.classList.contains('is-visible')) {
            updateDownloadQueueModal();
        }
    });

    window.addEventListener('scroll', () => {
        if (window.scrollY > 300) dom.backToTopBtn.classList.add('show');
        else dom.backToTopBtn.classList.remove('show');
        
        if (currentQuery && hasMoreResults && !isLoadingMore && (window.innerHeight + window.scrollY >= document.body.offsetHeight - 500)) {
            loadMoreSearchResults();
        }
    });

    dom.backToTopBtn.addEventListener('click', () => { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    
    dom.playerAlbumArt.addEventListener('click', () => {
        if (player.currentTrack && player.currentAlbumId) {
            const albumTitle = player.currentTrack?.album?.title;
            const cover = player.currentTrack?.album?.cover;
            if (albumTitle && cover) {
                const coverUrl = `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/320x320.jpg`;
                showTrackListInModal({ id: player.currentAlbumId, title: albumTitle }, albumTitle, coverUrl);
            }
        }
    });
    
    dom.playPauseBtn.addEventListener('click', () => player.togglePlayPause());
    dom.nextBtn.addEventListener('click', () => player.playNext());
    dom.prevBtn.addEventListener('click', () => player.playPrev());
    dom.stopBtn.addEventListener('click', () => player.stop());

    let isVolumeDragging = false;
    const updateVolumeFromEvent = (e) => {
        const rect = dom.volumeSlider.getBoundingClientRect();
        const clientY = e.clientY || (e.touches[0]?.clientY);
        if (clientY === undefined) return;
        const y = clientY - rect.top;
        const percentage = 1 - (y / rect.height);
        let volume = Math.max(0, Math.min(100, percentage * 100));
        dom.volumeSlider.value = volume;
        player.setVolume(volume);
    };
    dom.volumeSlider.addEventListener('mousedown', (e) => { isVolumeDragging = true; updateVolumeFromEvent(e); });
    window.addEventListener('mousemove', (e) => { if (isVolumeDragging) updateVolumeFromEvent(e); });
    window.addEventListener('mouseup', () => { isVolumeDragging = false; });
    dom.volumeSlider.addEventListener('touchstart', (e) => { isVolumeDragging = true; updateVolumeFromEvent(e.touches[0]); });
    window.addEventListener('touchmove', (e) => { if (isVolumeDragging) { e.preventDefault(); updateVolumeFromEvent(e.touches[0]); } }, { passive: false });
    window.addEventListener('touchend', () => { isVolumeDragging = false; });
    
    dom.playerAudioElement.addEventListener('play', () => player.setPlaying(true));
    dom.playerAudioElement.addEventListener('pause', () => player.setPlaying(false));
    dom.playerAudioElement.addEventListener('ended', () => player.playNext());
    dom.playerAudioElement.addEventListener('canplay', () => player.setLoading(false));
    dom.playerVideoElement.addEventListener('play', () => player.setPlaying(true));
    dom.playerVideoElement.addEventListener('pause', () => player.setPlaying(false));
    dom.playerVideoElement.addEventListener('ended', () => player.playNext());
    dom.playerVideoElement.addEventListener('waiting', () => player.setLoading(true));
    dom.playerVideoElement.addEventListener('playing', () => player.setLoading(false));

    dom.playerAudioElement.addEventListener('timeupdate', () => {
        if (player.activePlayer === dom.playerAudioElement) {
            const bar = document.querySelector('.track-progress-bar');
            if (bar && dom.playerAudioElement.duration) {
                bar.value = (dom.playerAudioElement.currentTime / dom.primaryAudioElement.duration) * 100;
            }
        }
    });

    dom.playerVideoElement.addEventListener('timeupdate', () => {
    });
}
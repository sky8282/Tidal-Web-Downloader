// js/modules/ui.js

import * as dom from './dom.js';
import { player } from './player.js';
import { getAlbumTracksAPI, getArtistDetailsAPI } from './api.js';
import { downloadAlbum, triggerDirectDownload, downloadQueue, triggerDirectVideoDownload } from './downloader.js';
import { copyTextToClipboard } from './utils.js';

export function updatePlayerUI() {
    document.querySelectorAll('.card').forEach(card => {
        card.classList.remove('is-active-album', 'is-playing');
        const playBtn = card.querySelector('.card-play-btn');
        if (playBtn) playBtn.classList.remove('is-playing');
    });

    if (!player.currentTrack) {
        updateGlobalPlayerState();
        return;
    }

    let selector = null;
    if (player.playerType === 'audio') {
         selector = player.currentAlbumId ? `.card[data-album-id="${player.currentAlbumId}"]` : `.card[data-track-id="${player.currentTrack.id}"]`;
    } else {
        selector = `.card[data-video-id="${player.currentTrack.id}"]`;
    }

    if (selector) {
        document.querySelectorAll(selector).forEach(card => {
            card.classList.add('is-active-album');
            if (player.isPlaying) {
                card.classList.add('is-playing');
                const playBtn = card.querySelector('.card-play-btn');
                if (playBtn) playBtn.classList.add('is-playing');
            }
        });
    }
    
    updateGlobalPlayerState();
}

function updateGlobalPlayerState() {
    const playPauseBtn = dom.playPauseBtn;
    playPauseBtn.className = 'player-btn large';
    playPauseBtn.disabled = !player.currentTrack && !player.isLoading;

    if (player.isLoading) playPauseBtn.classList.add('is-loading');
    else if (player.isPlaying) playPauseBtn.classList.add('is-playing');
    if (player.currentTrack && player.playerType === 'audio') {
        dom.globalPlayer.style.display = 'block';
        const cover = player.currentTrack?.album?.cover;
        dom.playerAlbumArt.src = cover ? `https://resources.tidal.com/images/${cover.replace(/-/g, '/')}/320x320.jpg` : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    } else {
        dom.globalPlayer.style.display = 'none';
    }
    dom.nextBtn.disabled = !player.hasNext();
    dom.prevBtn.disabled = !player.hasPrev();
}

export function updateTrackListUI() {
    dom.tracklistModalBody.querySelectorAll('.track-list-item').forEach(el => {
        el.classList.remove('is-playing');
        const btn = el.querySelector('.play-btn');
        if (btn) btn.classList.remove('is-playing');
    });

    dom.tracklistModalBody.querySelectorAll('.track-progress-bar-container').forEach(el => el.remove());
    if (player.currentTrack && player.playerType === 'audio' && dom.tracklistModal.classList.contains('is-visible')) {
        const item = dom.tracklistModalBody.querySelector(`[data-track-id="${player.currentTrack.id}"]`);
        if (item) {
            item.classList.add('is-playing');
            if (player.isPlaying) {
                const btn = item.querySelector('.play-btn');
                if (btn) btn.classList.add('is-playing');
            }
            const progressContainer = document.createElement('div');
            progressContainer.className = 'track-progress-bar-container';
            progressContainer.innerHTML = `<input type="range" class="track-progress-bar" value="0" step="0.1">`;
            
            const bar = progressContainer.firstChild;
            const audioEl = dom.playerAudioElement;
            if (audioEl && audioEl.duration > 0) {
                bar.value = (audioEl.currentTime / audioEl.duration) * 100;
            }
            bar.addEventListener('input', e => player.seek(e.target.value));
            item.appendChild(progressContainer);
        }
    }
}

export function displayHomepage(modules) {
    dom.resultsWall.innerHTML = '';
    
    const module = modules[0];
    if (!module) return;

    const currentItems = module.pagedList?.items || module.items;
    if (!currentItems || currentItems.length === 0) return;

    const wallId = 'homepage-wall';
    const wall = document.createElement('div');
    wall.className = 'cover-wall';
    wall.id = wallId;
    dom.resultsWall.appendChild(wall);

    appendResultsToWall(wallId, currentItems, module.type);
    const pagedList = module.pagedList;
    const dataPath = module.showMore?.apiPath || pagedList?.dataApiPath;
    
    if (pagedList && dataPath && pagedList.items.length < pagedList.totalNumberOfItems) {
        const sentinel = document.createElement('div');
        sentinel.className = 'load-more-sentinel';
        sentinel.dataset.modulePath = dataPath;
        sentinel.dataset.limit = pagedList.limit;
        const currentOffset = pagedList.offset || 0;
        const currentItemCount = pagedList.items.length;
        sentinel.dataset.offset = currentOffset + currentItemCount; 
        sentinel.dataset.total = pagedList.totalNumberOfItems;
        sentinel.dataset.wallId = wallId;
        sentinel.dataset.moduleType = module.type;
        sentinel.innerHTML = `<div class="loader"></div>`;
        dom.resultsWall.appendChild(sentinel);
    }
}

export function appendResultsToWall(wallId, items, moduleType) {
    const wall = document.getElementById(wallId);
    if (!wall) return;
    const isAlbumList = moduleType.includes('ALBUM');
    const isPlaylist = moduleType.includes('PLAYLIST');
    const isVideoList = moduleType.includes('VIDEO');
    const isArtistList = moduleType.includes('ARTIST');   
    items.forEach((itemData, index) => {
        const item = itemData.item || itemData;
        let cardType = 'track';
        if (isAlbumList) cardType = 'album';
        else if (isPlaylist) {
            cardType = 'playlist';
            item.cover = item.image || item.squareImage;
        }
        else if (isVideoList) cardType = 'video'; 
        else if (isArtistList) cardType = 'artist';
        const card = createCard(item, cardType);
        wall.appendChild(card);
    });
}

export function displayResults(results, searchType, clear = true, currentPage = 0) {
    if (clear) dom.resultsWall.innerHTML = '';
    
    let items = [], cardType = 'track';
    switch (searchType) {
        case 'al': items = results.albums?.items || results.items || []; cardType = 'album'; break;
        case 's': items = results.items || []; cardType = 'track'; break;
        case 'a': items = results.artists?.items || []; cardType = 'artist'; break;
        case 'v': items = results.items || []; cardType = 'video'; break; 
        default: items = [];
    }
    items = items.filter(Boolean);

    if (currentPage === 0 && items.length === 0) {
        dom.resultsWall.innerHTML = '<p>未找到结果</p>';
    } else {
        const wallId = "search-results-wall";
        if (clear) {
             const wall = document.createElement('div');
             wall.className = 'cover-wall';
             wall.id = wallId;
             dom.resultsWall.appendChild(wall);
        }
        let moduleType = 'TRACK_LIST';
        if (cardType === 'album') moduleType = 'ALBUM_LIST';
        else if (cardType === 'video') moduleType = 'VIDEO_LIST';
        else if (cardType === 'artist') moduleType = 'ARTIST_LIST';
        
        appendResultsToWall(wallId, items, moduleType);
    }
    return items.length >= 25;
}

function getBadgeText(tags) {
    if (!Array.isArray(tags)) return null;
    const hasHires = tags.includes('HIRES_LOSSLESS');
    const has360 = tags.includes('DOLBY_ATMOS');
    if (hasHires && has360) return 'Hi-Res / Atmos';
    if (hasHires) return 'Hi-Res';
    if (has360) return 'Atmos';
    return null;
}

function createCard(item, cardType) {
    const card = document.createElement('div'); card.className = 'card';
    const isAlbum = cardType === 'album';
    const isPlaylist = cardType === 'playlist';
    const isVideo = cardType === 'video';
    const isArtist = cardType === 'artist';
    card.dataset.item = JSON.stringify(item);
    const cover = item.cover || item.picture || item?.album?.cover || item.image || item.imageId;
    const coverId = cover ? cover.replace(/-/g, '/') : null;
    const coverUrl = coverId ? `https://resources.tidal.com/images/${coverId}/320x320.jpg` : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    
    const title = item.title || item.name || '';
    const artist = item.artist || (item.artists ? item.artists[0] : null);
    
    if (isAlbum) card.dataset.albumId = item.id;
    else if (cardType === 'track') card.dataset.trackId = item.id;
    else if (isPlaylist) card.dataset.playlistId = item.uuid;
    else if (isVideo) card.dataset.videoId = item.id;
    else if (isArtist) card.dataset.artistId = item.id;
    const badgeText = isVideo ? 'VIDEO' : getBadgeText(item.mediaMetadata?.tags);
    const dlIcon = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>`;
    const expandIcon = `<svg viewBox="0 0 24 24"><path d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z"></path></svg>`;
    const artistIcon = `<svg viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"></path></svg>`;
    const copyUrlIcon = `<svg viewBox="0 0 24 24"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"></path></svg>`;
    const copyNameIcon = `<svg viewBox="0 0 24 24"><path d="M3 15h18v-2H3v2zm0 4h18v-2H3v2zm0-8h18V9H3v2zm0-6v2h18V5H3z"></path></svg>`;
    
    card.innerHTML = `
        <div class="img-container">
            ${badgeText ? `<div class="card-badge">${badgeText}</div>` : ''}
            <img src="${coverUrl}" alt="${title}" loading="lazy">
            <div class="card-actions">
                <div class="card-actions-top"><div class="card-metadata-overlay"></div><div class="card-actions-top-right">${artist ? `<button class="action-artist" title="查看歌手">${artistIcon}</button>`: ''}</div></div>
                <div class="card-actions-bottom">
                    <button class="action-copy-url" title="复制链接">${copyUrlIcon}</button>
                    <button class="action-copy-name" title="复制标题">${copyNameIcon}</button>
                    
                    ${!isArtist && !isPlaylist ? `<button class="action-download" title="下载">${dlIcon}</button>` : ''}
                    
                    ${isAlbum ? `<button class="action-expand" title="查看曲目">${expandIcon}</button>` : ''}
                </div>
            </div>
        </div>
        <div class="card-info">
             <div class="card-title-row">
                <h3>${title}</h3>
                
                ${!isArtist && !isPlaylist ? `
                <button class="card-play-btn" title="播放">
                    <svg class="play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>
                    <svg class="pause-icon" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>
                </button>` : `<div class="card-play-btn-placeholder"></div>`}
            </div>
            ${!artist && !isArtist ? `<p class="card-subtitle">${item.description || ''}</p>` : ''}
        </div>`;
    
    const metadataOverlay = card.querySelector('.card-metadata-overlay');
    if (isAlbum && item.numberOfTracks) {
        const duration = item.duration ? new Date(item.duration * 1000).toISOString().substr(14, 5) : '';
        metadataOverlay.innerHTML = `<span>曲目：${item.numberOfTracks}</span><span>时长：${duration}</span>`;
    } else if (cardType === 'track') {
        const artistName = artist?.name || '';
        const quality = (item.audioQuality?.replace('_LOSSLESS', '')?.replace('_', ' ') || '');
        metadataOverlay.innerHTML = `<span>${artistName}</span><span>${quality}</span>`;
    } else if (isPlaylist && item.numberOfTracks) {
         metadataOverlay.innerHTML = `<span>曲目：${item.numberOfTracks}</span>`;
    }
    
    if (artist) {
      const artistIdToShow = (item.artists && item.artists[0]) ? item.artists[0].id : artist.id;
      card.querySelector('.action-artist')?.addEventListener('click', e => { e.stopPropagation(); displayArtistPage(artistIdToShow); });
    }
    
    card.querySelector('.action-copy-url').addEventListener('click', e => { e.stopPropagation(); copyTextToClipboard(item.url || `https://tidal.com/browse/${cardType}/${item.id || item.uuid}`, e.currentTarget); });
    card.querySelector('.action-copy-name').addEventListener('click', e => { e.stopPropagation(); copyTextToClipboard(title, e.currentTarget); });
    if (cardType === 'track' || cardType === 'album' || cardType === 'video') {
        const playBtn = card.querySelector('.card-play-btn');
        if (playBtn) {
            playBtn.addEventListener('click', e => {
                e.stopPropagation();
                if (isAlbum) {
                    if (player.currentAlbumId === item.id) player.togglePlayPause();
                    else startAlbumPlayback(item.id);
                } else {
                    if (player.currentTrack && player.currentTrack.id === item.id) player.togglePlayPause();
                    else {
                        const wall = card.closest('.cover-wall');
                        let newIndex = 0;
                        
                        if (wall) {
                            const allCards = Array.from(wall.querySelectorAll('.card'));
                            player.tracklist = allCards.map(c => JSON.parse(c.dataset.item));
                            newIndex = player.tracklist.findIndex(t => String(t.id) === String(item.id));
                        } else {
                            player.tracklist = [item]; 
                        }
                        
                        const playType = isVideo ? 'video' : 'audio';
                        
                        player.playTrackAtIndex(newIndex >= 0 ? newIndex : 0, item.album?.id, playType);
                        
                    }
                }
            });
        }
        const downloadBtn = card.querySelector('.action-download');
        if(downloadBtn) downloadBtn.addEventListener('click', e => { 
            e.stopPropagation(); 
            if (isAlbum) {
                downloadAlbum(item);
            } else if (isVideo) {
                triggerDirectVideoDownload(item); 
            } else {
                triggerDirectDownload(item);
            }
        });
    }
    if (isAlbum) card.querySelector('.action-expand').addEventListener('click', e => { e.stopPropagation(); showTrackListInModal(item, title, coverUrl); });
    if (isArtist) card.addEventListener('click', (e) => { e.stopPropagation(); displayArtistPage(item.id); });
    
    return card;
}

export async function showTrackListInModal(albumItem, albumName, coverUrl) {
    dom.tracklistModal.classList.add('is-visible');
    document.body.classList.add('modal-open');
    dom.tracklistModalTitle.textContent = albumName;
    dom.modalAlbumArt.src = coverUrl;
    dom.modalDownloadAlbumBtn.onclick = () => downloadAlbum(albumItem);
    dom.tracklistModalBody.innerHTML = '<p>正在加载曲目...</p>';
    try {
        const { tracks } = await getAlbumTracksAPI(albumItem.id);
        dom.tracklistModalBody.innerHTML = '';
        const playIcon = `<svg class="play-icon" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>`;
        const pauseIcon = `<svg class="pause-icon" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"></path></svg>`;
        const dlIcon = `<svg viewBox="0 0 24 24"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"></path></svg>`;

        tracks.forEach((track, i) => {
            const itemEl = document.createElement('div');
            itemEl.className = 'track-list-item';
            itemEl.dataset.trackId = track.id;
            itemEl.innerHTML = `<div class="track-info-row"><span>${i + 1}. ${track.title}</span><div class="track-actions"><button class="play-btn">${playIcon}${pauseIcon}</button><button class="dl-btn">${dlIcon}</button></div></div>`;
            itemEl.querySelector('.play-btn').addEventListener('click', () => {
                if (player.currentTrack && player.currentTrack.id === track.id) player.togglePlayPause();
                else {
                    player.tracklist = tracks;
                    player.playTrackAtIndex(i, albumItem.id, 'audio');
                }
            });
            itemEl.querySelector('.dl-btn').addEventListener('click', e => triggerDirectDownload(track));
            dom.tracklistModalBody.appendChild(itemEl);
        });
        updateTrackListUI();
    } catch (err) { dom.tracklistModalBody.innerHTML = `<p>加载曲目失败: ${err.message}</p>`; }
}

function navigateBack() {
    dom.artistPageContainer.style.display = 'none';
    dom.artistPageContainer.innerHTML = '';
    dom.resultsWall.style.display = 'flex';
    window.scrollTo(0, 0);
}

export async function displayArtistPage(artistId) {
    dom.resultsWall.style.display = 'none';
    dom.artistPageContainer.style.display = 'block';
    dom.artistPageContainer.innerHTML = '<div class="loading-indicator" style="display: block; height: 200px;"><div class="loader"></div></div>';
    window.scrollTo(0, 0);

    try {
        const { details, albums, singles, videos, related_artists } = await getArtistDetailsAPI(artistId);
        const backBtn = document.createElement('button');
        backBtn.className = 'artist-page-back-btn';
        backBtn.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"></path></svg> 返回`;
        backBtn.onclick = navigateBack;
        const header = document.createElement('div');
        header.className = 'artist-page-header';
        const picId = details.picture?.replace(/-/g, '/');
        header.innerHTML = `
            <img id="artist-page-avatar" src="${picId ? `https://resources.tidal.com/images/${picId}/160x160.jpg` : 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='}" alt="Artist Avatar">
            <h3 id="artist-page-title">${details.name}</h3>
        `;

        const body = document.createElement('div');
        body.id = 'artist-page-body';

        const createSection = (title, items, cardType = 'album') => {
            if (items && items.length > 0) {
                const titleEl = document.createElement('h4');
                titleEl.className = 'artist-section-title';
                titleEl.textContent = title;
                body.appendChild(titleEl);

                const wall = document.createElement('div');
                wall.className = 'cover-wall';
                items.forEach((item) => wall.appendChild(createCard(item, cardType)));
                body.appendChild(wall);
            }
        };
        
        createSection('专辑', albums, 'album');
        createSection('EP & 单曲', singles, 'album');
        createSection('视频', videos, 'video');
        createSection('相关艺人', related_artists, 'artist');
        dom.artistPageContainer.innerHTML = '';
        dom.artistPageContainer.appendChild(backBtn);
        dom.artistPageContainer.appendChild(header);
        dom.artistPageContainer.appendChild(body);

        updatePlayerUI();

    } catch (err) {
        dom.artistPageContainer.innerHTML = `<p>加载歌手详情失败: ${err.message}</p><button class="artist-page-back-btn" style="display: inline-flex; align-items: center; gap: 8px;"><svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"></path></svg> 返回</button>`;
        dom.artistPageContainer.querySelector('.artist-page-back-btn').onclick = navigateBack;
        console.error(err);
    }
}


export async function startAlbumPlayback(albumId) { 
    try { 
        const { tracks } = await getAlbumTracksAPI(albumId);

        if (tracks?.length) { 
            player.tracklist = tracks; 
            player.playTrackAtIndex(0, albumId, 'audio'); 
        } 
    } catch (err) { alert("播放专辑失败"); } 
}

export function updateDownloadQueueModal() {
    dom.downloadQueueBody.innerHTML = '';
    const cancelIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>`;
    
    let allTasks = [];
    
    if (downloadQueue.isProcessing && downloadQueue.currentTask) {
        allTasks.push({ ...downloadQueue.currentTask, isCurrent: true, id: downloadQueue.currentTask.trackId || 'current-album' });
    }
    
    downloadQueue.queue.forEach((task, index) => {
        allTasks.push({ ...task, isCurrent: false, id: task.trackId || `queued-${index}`, queueIndex: index });
    });

    if (allTasks.length === 0) {
        dom.downloadQueueBody.innerHTML = '<p>队列为空</p>';
        return;
    }

    allTasks.forEach((task) => {
        const itemEl = document.createElement('div');
        itemEl.className = 'queue-item';
        itemEl.dataset.taskId = task.id;
        if (task.isCurrent) {
            itemEl.classList.add('is-processing');
        }

        itemEl.innerHTML = `
            <div class="queue-item-header">
                <span class="queue-item-title">${task.isCurrent ? '[正在处理]' : '[等待中]'} ${task.name}</span>
                <button class="queue-item-cancel-btn" title="取消任务">${cancelIcon}</button>
            </div>
            ${task.isCurrent ? `
            <div class="queue-item-progress-container">
                <div class="queue-item-progress-bar" style="width: ${dom.downloadProgressBar.style.width || '0%'}"></div>
            </div>
            ` : ''}
        `;
        
        itemEl.querySelector('.queue-item-cancel-btn').addEventListener('click', () => {
            if (task.isCurrent) {
                downloadQueue.cancelCurrent();
            } else {
                downloadQueue.cancelTask(task.queueIndex);
            }
        });

        dom.downloadQueueBody.appendChild(itemEl);
    });
}

export function updateDownloadManagerStatus({ albumTitle, trackStatus, autoHide = false }) {
    dom.downloadManager.classList.add('visible');
    if (albumTitle !== undefined) dom.downloadAlbumTitle.textContent = albumTitle;
    if (trackStatus !== undefined) dom.downloadTrackStatus.textContent = trackStatus;

    if (autoHide) {
        setTimeout(() => {
            const queueCountElement = dom.downloadQueueCount;
            const hasQueue = queueCountElement && !queueCountElement.classList.contains('hidden') && parseInt(queueCountElement.textContent, 10) > 0;
            if (!hasQueue) dom.downloadManager.classList.remove('visible');
        }, 1500);
    }
}